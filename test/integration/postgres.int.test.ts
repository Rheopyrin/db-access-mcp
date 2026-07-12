import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDriver } from '../../src/dialects/postgres.driver';
import type { DbPool } from '../../src/interfaces/dialect-driver';
import { parseConfig } from '../../src/config/config.service';
import { DEFAULT_POOL } from '../../src/config/schema';
import { StderrLogger } from '../../src/logging/logger';

const logger = new StderrLogger('silent');
const driver = new PostgresDriver(logger);

let container: StartedTestContainer;
let host: string;
let port: number;

function connection(read_only: boolean, allowMulti = false) {
  return parseConfig({
    connections: {
      db: {
        type: 'postgres',
        read_only,
        options: { host, port, database: 'testdb', user: 'test', password: 'test', multipleStatements: allowMulti },
      },
    },
  }).connections['db']!;
}

async function makePool(read_only = false, allowMulti = false): Promise<DbPool> {
  const config = connection(read_only, allowMulti);
  return driver.createPool({
    key: 'db',
    config,
    renderedOptions: config.options,
    pool: DEFAULT_POOL,
  });
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  host = container.getHost();
  port = container.getMappedPort(5432);
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

describe('postgres integration', () => {
  it('executes queries and returns typed columns', async () => {
    const pool = await makePool();
    try {
      const result = await pool.query('SELECT 1 AS one, \'x\' AS s', { maxRows: 10, timeoutMs: 5_000 });
      expect(result.rows).toEqual([{ one: 1, s: 'x' }]);
      expect(result.columns.map((c) => c.name)).toEqual(['one', 's']);
      expect(result.truncated).toBe(false);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await pool.end();
    }
  });

  it('truncates at max_rows and flags it', async () => {
    const pool = await makePool();
    try {
      const result = await pool.query('SELECT generate_series(1, 100) AS n', { maxRows: 10, timeoutMs: 5_000 });
      expect(result.rowCount).toBe(10);
      expect(result.truncated).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('enforces statement_timeout server-side', async () => {
    const pool = await makePool();
    try {
      await expect(pool.query('SELECT pg_sleep(10)', { maxRows: 10, timeoutMs: 300 })).rejects.toMatchObject({
        code: '57014',
      });
    } finally {
      await pool.end();
    }
  });

  it('read_only sessions reject writes', async () => {
    const pool = await makePool(true);
    try {
      await expect(
        pool.query('CREATE TABLE should_fail (id int)', { maxRows: 10, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ code: '25006' }); // read_only_sql_transaction
    } finally {
      await pool.end();
    }
  });

  it('rejects multi-statement by default (extended protocol, 42601)', async () => {
    const pool = await makePool();
    try {
      await expect(
        pool.query('SELECT 1 AS a; SELECT 2 AS b;', { maxRows: 10, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ code: '42601' }); // cannot insert multiple commands into a prepared statement
    } finally {
      await pool.end();
    }
  });

  it('a multi-statement read-only bypass is blocked by default', async () => {
    const pool = await makePool(true); // read_only
    try {
      await expect(
        pool.query('SET default_transaction_read_only = off; CREATE TABLE bypass_t (id int)', {
          maxRows: 10,
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: '42601' });
    } finally {
      await pool.end();
    }
  });

  it('runs multi-statement scripts when options.multipleStatements is true', async () => {
    const pool = await makePool(false, true);
    try {
      const result = await pool.query('SELECT 1 AS a; SELECT 2 AS b;', { maxRows: 10, timeoutMs: 5_000 });
      expect(result.rows).toEqual([{ a: 1 }]);
      expect(result.resultSets?.[0]?.rows).toEqual([{ b: 2 }]);
    } finally {
      await pool.end();
    }
  });

  it('produces a JSON explain plan', async () => {
    const pool = await makePool();
    try {
      const result = await pool.query(driver.buildExplainSql('SELECT 1'), { maxRows: 10, timeoutMs: 5_000 });
      const plan = result.rows[0]?.['QUERY PLAN'];
      expect(Array.isArray(plan)).toBe(true);
      expect((plan as { Plan: unknown }[])[0]).toHaveProperty('Plan');
    } finally {
      await pool.end();
    }
  });

  it('DML reports affectedRows', async () => {
    const pool = await makePool();
    try {
      await pool.query('CREATE TABLE t_dml (id int)', { maxRows: 10, timeoutMs: 5_000 });
      const result = await pool.query('INSERT INTO t_dml SELECT generate_series(1, 5)', {
        maxRows: 10,
        timeoutMs: 5_000,
      });
      expect(result.affectedRows).toBe(5);
    } finally {
      await pool.end();
    }
  });

  it('serverInfoSql returns version, user and database', async () => {
    const pool = await makePool();
    try {
      const result = await pool.query(driver.serverInfoSql(), { maxRows: 1, timeoutMs: 5_000 });
      const row = result.rows[0]!;
      expect(String(row['version'])).toContain('PostgreSQL');
      expect(row['user']).toBe('test');
      expect(row['database']).toBe('testdb');
    } finally {
      await pool.end();
    }
  });

  it('multi-database connection routes pools to distinct databases', async () => {
    const bootstrap = await makePool();
    try {
      await bootstrap.query('CREATE DATABASE seconddb', { maxRows: 1, timeoutMs: 10_000 });
    } finally {
      await bootstrap.end();
    }

    const config = parseConfig({
      connections: {
        db: {
          type: 'postgres',
          options: { host, port, databases: ['testdb', 'seconddb'], user: 'test', password: 'test' },
        },
      },
    }).connections['db']!;

    const pools: Record<string, Awaited<ReturnType<typeof driver.createPool>>> = {};
    try {
      for (const database of ['testdb', 'seconddb']) {
        const options: Record<string, unknown> = { ...config.options, database };
        delete options['databases'];
        pools[database] = await driver.createPool({
          key: 'db',
          config,
          renderedOptions: options,
          pool: DEFAULT_POOL,
        });
        const result = await pools[database].query('SELECT current_database() AS db', {
          maxRows: 1,
          timeoutMs: 5_000,
        });
        expect(result.rows).toEqual([{ db: database }]);
      }
    } finally {
      await Promise.all(Object.values(pools).map((p) => p.end()));
    }
  });

  it('queryStream delivers all rows in order without buffering (50k rows)', async () => {
    const pool = await makePool();
    try {
      let count = 0;
      let last = 0;
      const result = await pool.queryStream!('SELECT generate_series(1, 50000) AS n', { timeoutMs: 30_000 }, (row) => {
        count += 1;
        last = row['n'] as number;
      });
      expect(count).toBe(50_000);
      expect(last).toBe(50_000);
      expect(result.rowCount).toBe(50_000);
      expect(result.columns).toEqual([{ name: 'n' }]);
    } finally {
      await pool.end();
    }
  });
});
