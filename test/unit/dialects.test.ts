import { describe, expect, it } from 'vitest';
import { mapMysqlResults, MysqlDriver, parseMysqlUri, MYSQL_TIMEOUT_CODE } from '../../src/dialects/mysql.driver';
import { mapPgResults, PostgresDriver } from '../../src/dialects/postgres.driver';
import { RedshiftDriver } from '../../src/dialects/redshift.driver';
import { StderrLogger } from '../../src/logging/logger';

const logger = new StderrLogger('silent');
const pgDriver = new PostgresDriver(logger);
const rsDriver = new RedshiftDriver(logger);
const myDriver = new MysqlDriver(logger);

describe('PostgresDriver', () => {
  it('classifies connection errors: syscall, SQLSTATE 08*, 57P0x, messages', () => {
    expect(pgDriver.classifyError({ code: 'ECONNREFUSED' })).toBe('connection');
    expect(pgDriver.classifyError({ code: '08006' })).toBe('connection');
    expect(pgDriver.classifyError({ code: '57P01' })).toBe('connection');
    expect(pgDriver.classifyError({ message: 'Connection terminated unexpectedly' })).toBe('connection');
    expect(pgDriver.classifyError({ message: 'timeout expired' })).toBe('connection');
  });

  it('classifies auth errors as non-retryable', () => {
    expect(pgDriver.classifyError({ code: '28P01' })).toBe('auth');
    expect(pgDriver.classifyError({ code: '28000' })).toBe('auth');
  });

  it('classifies SQL errors as query', () => {
    expect(pgDriver.classifyError({ code: '42601', message: 'syntax error' })).toBe('query');
  });

  it('detects statement_timeout (57014)', () => {
    expect(pgDriver.isTimeoutError({ code: '57014' })).toBe(true);
    expect(pgDriver.classifyError({ code: '57014' })).toBe('query');
  });

  it('extracts an endpoint from discrete options', () => {
    expect(pgDriver.extractEndpoint({ host: 'h', port: '5433', database: 'd' })).toEqual({
      host: 'h',
      port: 5433,
      database: 'd',
    });
  });

  it('extracts an endpoint from a connectionString', () => {
    expect(pgDriver.extractEndpoint({ connectionString: 'postgres://u:p@db.internal:6432/appdb' })).toEqual({
      host: 'db.internal',
      port: 6432,
      database: 'appdb',
    });
  });

  it('builds JSON explain', () => {
    expect(pgDriver.buildExplainSql('SELECT 1')).toBe('EXPLAIN (FORMAT JSON) SELECT 1');
    expect(pgDriver.explainFormat).toBe('json');
  });

  it('maps multi-statement results into resultSets', () => {
    const result = mapPgResults(
      [
        { command: 'SELECT', rowCount: 2, rows: [{ a: 1 }, { a: 2 }], fields: [{ name: 'a', dataTypeID: 23 }] },
        { command: 'UPDATE', rowCount: 5, rows: [], fields: [] },
      ] as never,
      1,
      42,
    );
    expect(result.rows).toEqual([{ a: 1 }]);
    expect(result.truncated).toBe(true);
    expect(result.elapsedMs).toBe(42);
    expect(result.resultSets).toHaveLength(1);
    expect(result.resultSets?.[0]?.affectedRows).toBe(5);
  });
});

describe('RedshiftDriver', () => {
  it('uses text explain and port 5439', () => {
    expect(rsDriver.buildExplainSql('SELECT 1')).toBe('EXPLAIN SELECT 1');
    expect(rsDriver.explainFormat).toBe('text');
    expect(rsDriver.defaultPort()).toBe(5439);
    expect(rsDriver.dialect).toBe('redshift');
  });
});

describe('MysqlDriver', () => {
  it('classifies connection, auth and fatal errors', () => {
    expect(myDriver.classifyError({ code: 'PROTOCOL_CONNECTION_LOST' })).toBe('connection');
    expect(myDriver.classifyError({ code: 'ECONNRESET' })).toBe('connection');
    expect(myDriver.classifyError({ code: 'ER_ACCESS_DENIED_ERROR' })).toBe('auth');
    expect(myDriver.classifyError({ code: 'ER_PARSE_ERROR' })).toBe('query');
    expect(myDriver.classifyError({ fatal: true })).toBe('connection');
  });

  it('detects the local query timeout marker', () => {
    expect(myDriver.isTimeoutError({ code: MYSQL_TIMEOUT_CODE })).toBe(true);
  });

  it('parses mysql:// uris', () => {
    expect(parseMysqlUri('mysql://user:p%40ss@db.host:3307/appdb?charset=utf8mb4')).toEqual({
      host: 'db.host',
      port: 3307,
      user: 'user',
      password: 'p@ss',
      database: 'appdb',
      charset: 'utf8mb4',
    });
  });

  it('maps a single select result with truncation', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }];
    const fields = [{ name: 'a', type: 3 }];
    const result = mapMysqlResults(rows, fields, 2, 7);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.columns).toEqual([{ name: 'a', type: '3' }]);
  });

  it('maps a DML ResultSetHeader', () => {
    const result = mapMysqlResults({ affectedRows: 3 }, undefined, 10, 1);
    expect(result.affectedRows).toBe(3);
    expect(result.rows).toEqual([]);
  });

  it('maps multi-statement results', () => {
    const rows = [[{ a: 1 }], { affectedRows: 2 }];
    const fields = [[{ name: 'a', type: 3 }], undefined];
    const result = mapMysqlResults(rows, fields, 10, 5);
    expect(result.rows).toEqual([{ a: 1 }]);
    expect(result.resultSets).toHaveLength(1);
    expect(result.resultSets?.[0]?.affectedRows).toBe(2);
  });
});
