import { describe, expect, it } from 'vitest';
import {
  mapMssqlResult,
  MssqlDbPool,
  MssqlDriver,
  MSSQL_CANCEL_CODE,
  overrideAdoServer,
  parseAdoConnectionString,
  parseMssqlUrl,
} from '../../src/dialects/mssql.driver';
import { StderrLogger } from '../../src/logging/logger';

const driver = new MssqlDriver(new StderrLogger('silent'));

describe('MssqlDriver', () => {
  it('classifies errors: login, socket, cancel, timeouts, request', () => {
    expect(driver.classifyError({ code: 'ELOGIN' })).toBe('auth');
    expect(driver.classifyError({ code: 'ESOCKET' })).toBe('connection');
    expect(driver.classifyError({ code: 'ECONNCLOSED' })).toBe('connection');
    expect(driver.classifyError({ code: 'ECONNRESET' })).toBe('connection');
    expect(driver.classifyError({ code: MSSQL_CANCEL_CODE })).toBe('query');
    expect(driver.classifyError({ code: 'ETIMEOUT', name: 'ConnectionError' })).toBe('connection');
    expect(driver.classifyError({ code: 'ETIMEOUT', name: 'RequestError' })).toBe('query');
    expect(driver.classifyError({ code: 'EREQUEST' })).toBe('query');
  });

  it('treats cancel as the timeout marker', () => {
    expect(driver.isTimeoutError({ code: MSSQL_CANCEL_CODE })).toBe(true);
    expect(driver.isTimeoutError({ code: 'EREQUEST' })).toBe(false);
  });

  it('extracts endpoints from discrete options with host alias', () => {
    expect(driver.extractEndpoint({ host: 'h', port: '1444', database: 'erp' })).toEqual({
      host: 'h',
      port: 1444,
      database: 'erp',
    });
    expect(driver.extractEndpoint({ server: 's', port: 1433 })).toEqual({
      host: 's',
      port: 1433,
      database: undefined,
    });
  });

  it('extracts endpoints from mssql:// urls and ADO connection strings', () => {
    expect(driver.extractEndpoint({ connectionString: 'mssql://u:p@db.host:1444/erp' })).toEqual({
      host: 'db.host',
      port: 1444,
      database: 'erp',
    });
    expect(
      driver.extractEndpoint({ connectionString: 'Server=tcp:db.host,1444;Initial Catalog=erp;User Id=u' }),
    ).toEqual({ host: 'db.host', port: 1444, database: 'erp' });
  });

  it('defaults to port 1433 and text explain format', () => {
    expect(driver.defaultPort()).toBe(1433);
    expect(driver.explainFormat).toBe('text');
  });
});

describe('mssql helpers', () => {
  it('parseMssqlUrl decodes credentials', () => {
    expect(parseMssqlUrl('mssql://user:p%40ss@h:1433/db')).toEqual({
      server: 'h',
      port: 1433,
      user: 'user',
      password: 'p@ss',
      database: 'db',
    });
  });

  it('parseAdoConnectionString handles Data Source and bare hosts', () => {
    expect(parseAdoConnectionString('Data Source=myhost;Database=d')).toEqual({
      host: 'myhost',
      port: undefined,
      database: 'd',
    });
  });

  it('overrideAdoServer rewrites or prepends the server', () => {
    expect(overrideAdoServer('Server=old,1433;Database=d', '127.0.0.1', 21_000)).toBe(
      'Server=127.0.0.1,21000;Database=d',
    );
    expect(overrideAdoServer('Database=d', '127.0.0.1', 21_000)).toBe('Server=127.0.0.1,21000;Database=d');
  });
});

describe('mapMssqlResult', () => {
  function recordset(rows: Record<string, unknown>[], columns: string[]): Record<string, unknown>[] {
    const rs = [...rows] as Record<string, unknown>[] & { columns: Record<string, unknown> };
    rs.columns = Object.fromEntries(columns.map((name, index) => [name, { index, type: { name: 'Int' } }]));
    return rs;
  }

  it('maps recordsets with truncation and column order', () => {
    const result = mapMssqlResult(
      { recordsets: [recordset([{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }], ['a', 'b'])], rowsAffected: [] },
      2,
      11,
    );
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.columns.map((c) => c.name)).toEqual(['a', 'b']);
    expect(result.elapsedMs).toBe(11);
  });

  it('maps DML with rowsAffected and no recordsets', () => {
    const result = mapMssqlResult({ recordsets: [], rowsAffected: [3, 2] }, 10, 1);
    expect(result.affectedRows).toBe(5);
    expect(result.rows).toEqual([]);
  });

  it('maps multiple recordsets into resultSets', () => {
    const result = mapMssqlResult(
      { recordsets: [recordset([{ a: 1 }], ['a']), recordset([{ b: 2 }], ['b'])], rowsAffected: [] },
      10,
      1,
    );
    expect(result.rows).toEqual([{ a: 1 }]);
    expect(result.resultSets?.[0]?.rows).toEqual([{ b: 2 }]);
  });
});

describe('MssqlDbPool.explain timeout', () => {
  /** Fake transaction whose query() hangs until the request is cancelled. */
  function fakeConnectionPool() {
    const state = { cancels: 0, rolledBack: false, committed: false };
    const makeRequest = () => {
      const req: Record<string, unknown> = {
        batch: async () => ({ recordsets: [], rowsAffected: [] }),
      };
      req['query'] = () =>
        new Promise((_resolve, reject) => {
          req['cancel'] = () => {
            state.cancels += 1;
            reject(Object.assign(new Error('canceled'), { code: MSSQL_CANCEL_CODE }));
          };
        });
      req['cancel'] = () => {
        state.cancels += 1;
      };
      return req;
    };
    const transaction = {
      begin: async () => {},
      request: () => makeRequest(),
      commit: async () => {
        state.committed = true;
      },
      rollback: async () => {
        state.rolledBack = true;
      },
    };
    return { pool: { transaction: () => transaction }, state };
  }

  it('cancels the in-flight request and rolls back when the deadline hits', async () => {
    const { pool, state } = fakeConnectionPool();
    const dbPool = new MssqlDbPool(pool as never);
    await expect(dbPool.explain('SELECT 1', { maxRows: 10, timeoutMs: 20 })).rejects.toMatchObject({
      code: MSSQL_CANCEL_CODE,
    });
    expect(state.cancels).toBeGreaterThanOrEqual(1);
    expect(state.rolledBack).toBe(true);
    expect(state.committed).toBe(false);
  });
});
