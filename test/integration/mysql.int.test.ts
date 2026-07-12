import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MysqlDriver } from '../../src/dialects/mysql.driver';
import type { DbPool } from '../../src/interfaces/dialect-driver';
import { parseConfig } from '../../src/config/config.service';
import { DEFAULT_POOL } from '../../src/config/schema';
import { StderrLogger } from '../../src/logging/logger';

const logger = new StderrLogger('silent');
const driver = new MysqlDriver(logger);

let container: StartedTestContainer;
let host: string;
let port: number;

async function makePool(extraOptions: Record<string, unknown> = {}, read_only = false): Promise<DbPool> {
  const config = parseConfig({
    connections: {
      db: {
        type: 'mysql',
        read_only,
        options: { host, port, database: 'testdb', user: 'test', password: 'test', ...extraOptions },
      },
    },
  }).connections['db']!;
  return driver.createPool({
    key: 'db',
    config,
    renderedOptions: config.options,
    pool: DEFAULT_POOL,
  });
}

beforeAll(async () => {
  container = await new GenericContainer('mysql:8')
    .withEnvironment({
      MYSQL_ROOT_PASSWORD: 'root',
      MYSQL_USER: 'test',
      MYSQL_PASSWORD: 'test',
      MYSQL_DATABASE: 'testdb',
    })
    .withExposedPorts(3306)
    .withWaitStrategy(Wait.forLogMessage(/ready for connections.*port: 3306/s, 1))
    .start();
  host = container.getHost();
  port = container.getMappedPort(3306);
  // mysql needs a moment after the log line before auth works reliably
  await new Promise((r) => setTimeout(r, 3_000));
}, 240_000);

afterAll(async () => {
  await container?.stop();
});

describe('mysql integration', () => {
  it('executes queries with truncation', async () => {
    const pool = await makePool();
    try {
      await pool.query('CREATE TABLE t1 (n int)', { maxRows: 10, timeoutMs: 10_000 });
      await pool.query('INSERT INTO t1 VALUES (1),(2),(3),(4),(5)', { maxRows: 10, timeoutMs: 10_000 });
      const result = await pool.query('SELECT n FROM t1 ORDER BY n', { maxRows: 3, timeoutMs: 10_000 });
      expect(result.rowCount).toBe(3);
      expect(result.truncated).toBe(true);
      expect(result.rows[0]).toEqual({ n: 1 });
    } finally {
      await pool.end();
    }
  });

  it('read_only sessions reject writes (MySQL 5.6+)', async () => {
    const pool = await makePool({}, true);
    try {
      await expect(
        pool.query('CREATE TABLE should_fail (id int)', { maxRows: 10, timeoutMs: 10_000 }),
      ).rejects.toMatchObject({ code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' });
    } finally {
      await pool.end();
    }
  });

  it('multi-statement is rejected by default', async () => {
    const pool = await makePool();
    try {
      await expect(pool.query('SELECT 1; SELECT 2;', { maxRows: 10, timeoutMs: 10_000 })).rejects.toMatchObject({
        code: 'ER_PARSE_ERROR',
      });
    } finally {
      await pool.end();
    }
  });

  it('multi-statement works when options.multipleStatements is true', async () => {
    const pool = await makePool({ multipleStatements: true });
    try {
      const result = await pool.query('SELECT 1 AS a; SELECT 2 AS b;', { maxRows: 10, timeoutMs: 10_000 });
      expect(result.rows).toEqual([{ a: 1 }]);
      expect(result.resultSets?.[0]?.rows).toEqual([{ b: 2 }]);
    } finally {
      await pool.end();
    }
  });

  it('client-side timeout destroys the connection and reports QUERY_TIMEOUT class', async () => {
    const pool = await makePool();
    try {
      await expect(pool.query('SELECT SLEEP(10)', { maxRows: 10, timeoutMs: 300 })).rejects.toMatchObject({
        code: 'PROTOCOL_SEQUENCE_TIMEOUT',
      });
      // The pool must still work after the destroyed connection.
      const ok = await pool.query('SELECT 1 AS ok', { maxRows: 10, timeoutMs: 10_000 });
      expect(ok.rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  });

  it('produces a JSON explain plan', async () => {
    const pool = await makePool();
    try {
      const result = await pool.query(driver.buildExplainSql('SELECT 1'), { maxRows: 10, timeoutMs: 10_000 });
      const cell = result.rows[0]?.['EXPLAIN'];
      expect(typeof cell).toBe('string');
      expect(JSON.parse(cell as string)).toHaveProperty('query_block');
    } finally {
      await pool.end();
    }
  });

  it('serverInfoSql returns version, user and database', async () => {
    const pool = await makePool();
    try {
      const result = await pool.query(driver.serverInfoSql(), { maxRows: 1, timeoutMs: 10_000 });
      const row = result.rows[0]!;
      expect(String(row['version'])).toMatch(/^\d+\./);
      expect(String(row['user'])).toContain('test');
      expect(row['database']).toBe('testdb');
    } finally {
      await pool.end();
    }
  });

  it('queryStream delivers all rows in order (32k rows)', async () => {
    const pool = await makePool();
    const opts = { maxRows: 10, timeoutMs: 30_000 };
    try {
      await pool.query('CREATE TABLE stream_t (n INT)', opts);
      await pool.query('INSERT INTO stream_t VALUES (1)', opts);
      // Double the table 15 times: 2^15 = 32768 rows.
      for (let i = 0; i < 15; i += 1) {
        await pool.query('INSERT INTO stream_t SELECT n + (SELECT COUNT(*) FROM (SELECT * FROM stream_t) c) FROM stream_t', opts);
      }
      let count = 0;
      let last = 0;
      const result = await pool.queryStream!('SELECT n FROM stream_t ORDER BY n', { timeoutMs: 30_000 }, (row) => {
        count += 1;
        last = row['n'] as number;
      });
      expect(count).toBe(32_768);
      expect(last).toBe(32_768);
      expect(result.rowCount).toBe(32_768);
    } finally {
      await pool.end();
    }
  });
});
