import mysql from 'mysql2/promise';
import type { Connection as CallbackConnection } from 'mysql2';
import type {
  CreatePoolInput,
  DbPool,
  DialectDriver,
  Endpoint,
  ErrorClass,
  QueryOptions,
  QueryResult,
  StreamResult,
} from '../interfaces/dialect-driver';
import type { Logger } from '../interfaces/logger';

const SYSCALL_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']);
const CONNECTION_CODES = new Set(['PROTOCOL_CONNECTION_LOST', 'ER_CON_COUNT_ERROR', 'POOL_CLOSED', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR']);
const AUTH_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR']);

/** mysql2's per-query inactivity timeout error code. */
export const MYSQL_TIMEOUT_CODE = 'PROTOCOL_SEQUENCE_TIMEOUT';

interface ResultSetHeaderLike {
  affectedRows: number;
}

function isResultSetHeader(value: unknown): value is ResultSetHeaderLike {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as ResultSetHeaderLike).affectedRows === 'number'
  );
}

function mapSingleSet(rows: unknown, fields: mysql.FieldPacket[] | undefined, maxRows: number): QueryResult {
  if (isResultSetHeader(rows)) {
    return { columns: [], rows: [], rowCount: 0, affectedRows: rows.affectedRows, truncated: false, elapsedMs: 0 };
  }
  const list = (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];
  const truncated = list.length > maxRows;
  const sliced = truncated ? list.slice(0, maxRows) : list;
  return {
    columns: (fields ?? []).map((f) => ({ name: f.name, type: String(f.type ?? '') })),
    rows: sliced,
    rowCount: sliced.length,
    truncated,
    elapsedMs: 0,
  };
}

export function mapMysqlResults(rows: unknown, fields: unknown, maxRows: number, elapsedMs: number): QueryResult {
  const fieldList = fields as (mysql.FieldPacket[] | undefined)[] | mysql.FieldPacket[] | undefined;
  const isMulti =
    Array.isArray(rows) &&
    Array.isArray(fieldList) &&
    fieldList.length > 0 &&
    (fieldList as unknown[]).every((f) => f === undefined || Array.isArray(f));

  if (isMulti) {
    const sets = (rows as unknown[]).map((set, i) =>
      mapSingleSet(set, (fieldList as (mysql.FieldPacket[] | undefined)[])[i], maxRows),
    );
    const first = sets[0] ?? { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs };
    first.elapsedMs = elapsedMs;
    if (sets.length > 1) first.resultSets = sets.slice(1);
    return first;
  }

  const single = mapSingleSet(rows, fieldList as mysql.FieldPacket[] | undefined, maxRows);
  single.elapsedMs = elapsedMs;
  return single;
}

/** Parses mysql://user:pass@host:port/db?params into option fields. */
export function parseMysqlUri(uri: string): Record<string, unknown> {
  const url = new URL(uri);
  const out: Record<string, unknown> = {};
  if (url.hostname) out['host'] = url.hostname;
  if (url.port) out['port'] = Number(url.port);
  if (url.username) out['user'] = decodeURIComponent(url.username);
  if (url.password) out['password'] = decodeURIComponent(url.password);
  const database = url.pathname.replace(/^\//, '');
  if (database) out['database'] = database;
  for (const [k, v] of url.searchParams) out[k] = v;
  return out;
}

class MysqlDbPool implements DbPool {
  private readonlyMode: 'off' | 'best_effort';
  private ended = false;

  constructor(
    private readonly pool: mysql.Pool,
    readOnly: boolean,
    private readonly logger: Logger,
  ) {
    this.readonlyMode = readOnly ? 'best_effort' : 'off';
  }

  async query(sql: string, opts: QueryOptions): Promise<QueryResult> {
    const conn = await this.pool.getConnection();
    const started = Date.now();
    let broken = false;
    try {
      await this.applyReadonly(conn);
      // mysql2's client-side inactivity timeout; the server may keep running
      // the statement, so the connection is destroyed below on timeout.
      const [rows, fields] = await conn.query({ sql, timeout: Math.max(1, Math.floor(opts.timeoutMs)) });
      return mapMysqlResults(rows, fields, opts.maxRows, Date.now() - started);
    } catch (err) {
      // Destroy the connection on any failure: after a timeout the server may
      // still be executing the statement on it; other errors may leave the
      // session in an unknown state.
      broken = true;
      throw err;
    } finally {
      if (broken) {
        conn.destroy();
      } else {
        conn.release();
      }
    }
  }

  private async applyReadonly(conn: mysql.PoolConnection): Promise<void> {
    if (this.readonlyMode === 'off') return;
    try {
      await conn.query('SET SESSION TRANSACTION READ ONLY');
    } catch (err) {
      // MySQL < 5.6 does not support read-only sessions — warn once and continue.
      this.logger.warn(
        'read_only requested but SET SESSION TRANSACTION READ ONLY failed (MySQL < 5.6?); use a read-only database user',
        { err },
      );
      this.readonlyMode = 'off';
    }
  }

  /** Row streaming via mysql2's stream API; async iteration gives backpressure. */
  async queryStream(
    sql: string,
    opts: { timeoutMs: number },
    onRow: (row: Record<string, unknown>) => Promise<void> | void,
  ): Promise<StreamResult> {
    const conn = await this.pool.getConnection();
    let broken = false;
    try {
      await this.applyReadonly(conn);
      // The promise wrapper types .connection as a promise Connection, but at
      // runtime it is the callback connection whose query() returns a Query
      // with .stream().
      const callbackConn = conn.connection as unknown as CallbackConnection;
      const stream = callbackConn.query({ sql, timeout: Math.max(1, Math.floor(opts.timeoutMs)) }).stream();
      let columns: StreamResult['columns'] | undefined;
      let rowCount = 0;
      for await (const row of stream as AsyncIterable<Record<string, unknown>>) {
        columns ??= Object.keys(row).map((name) => ({ name }));
        await onRow(row);
        rowCount += 1;
      }
      return { columns: columns ?? [], rowCount };
    } catch (err) {
      broken = true;
      throw err;
    } finally {
      if (broken) {
        conn.destroy();
      } else {
        conn.release();
      }
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.pool.end();
  }
}

export class MysqlDriver implements DialectDriver {
  readonly dialect: string = 'mysql';
  readonly explainFormat: 'json' | 'text' = 'json';

  constructor(private readonly logger: Logger) {}

  defaultPort(): number {
    return 3306;
  }

  extractEndpoint(options: Record<string, unknown>): Endpoint {
    let opts = options;
    if (typeof options['uri'] === 'string') {
      try {
        opts = { ...parseMysqlUri(options['uri']), ...options };
      } catch {
        return {};
      }
    }
    return {
      host: typeof opts['host'] === 'string' ? opts['host'] : undefined,
      port: opts['port'] !== undefined && opts['port'] !== null ? Number(opts['port']) : undefined,
      database: typeof opts['database'] === 'string' ? opts['database'] : undefined,
    };
  }

  async createPool(input: CreatePoolInput): Promise<DbPool> {
    let base: Record<string, unknown> = { ...input.renderedOptions };
    if (typeof base['uri'] === 'string') {
      // Parse the uri ourselves so tunnel endpoint overrides win deterministically.
      const parsed = parseMysqlUri(base['uri']);
      delete base['uri'];
      base = { ...parsed, ...base };
    }
    if (input.endpoint) {
      base['host'] = input.endpoint.host;
      base['port'] = input.endpoint.port;
    }
    if (base['port'] !== undefined && base['port'] !== null) base['port'] = Number(base['port']);
    const pool = mysql.createPool({
      ...base,
      // Only an explicit `true` enables multi-statement; anything else (incl.
      // omitted) is a single statement per call. Normalized after ...base.
      multipleStatements: base['multipleStatements'] === true,
      waitForConnections: true,
      connectionLimit: input.pool.max,
      maxIdle: Math.max(input.pool.min, 1),
      idleTimeout: input.pool.idle_timeout_ms,
      connectTimeout: input.pool.connection_timeout_ms,
    } as mysql.PoolOptions);
    return new MysqlDbPool(pool, input.config.read_only, this.logger.child({ connection: input.key }));
  }

  buildExplainSql(query: string): string {
    return `EXPLAIN FORMAT=JSON ${query}`;
  }

  serverInfoSql(): string {
    return 'SELECT VERSION() AS `version`, CURRENT_USER() AS `user`, DATABASE() AS `database`';
  }

  classifyError(err: unknown): ErrorClass {
    const e = err as { code?: string; fatal?: boolean } | undefined;
    if (!e) return 'unknown';
    const code = e.code ?? '';
    if (AUTH_CODES.has(code)) return 'auth';
    if (code === MYSQL_TIMEOUT_CODE) return 'query';
    if (SYSCALL_CODES.has(code) || CONNECTION_CODES.has(code)) return 'connection';
    if (e.fatal === true) return 'connection';
    if (code !== '') return 'query';
    return 'unknown';
  }

  isTimeoutError(err: unknown): boolean {
    return (err as { code?: string } | undefined)?.code === MYSQL_TIMEOUT_CODE;
  }
}
