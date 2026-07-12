import sql from 'mssql';
import type {
  CreatePoolInput,
  DbPool,
  DialectDriver,
  Endpoint,
  ErrorClass,
  QueryOptions,
  QueryResult,
} from '../interfaces/dialect-driver';
import type { Logger } from '../interfaces/logger';

const SYSCALL_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']);
const CONNECTION_CODES = new Set(['ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'ENOTBEGUN']);

/** mssql error code emitted when request.cancel() aborts a query (our timeout). */
export const MSSQL_CANCEL_CODE = 'ECANCEL';

interface MssqlRecordset extends Array<Record<string, unknown>> {
  columns?: Record<string, { index: number; type?: { name?: string } }>;
}

export function mapMssqlResult(
  result: { recordsets: unknown; rowsAffected: number[] },
  maxRows: number,
  elapsedMs: number,
): QueryResult {
  const recordsets = (result.recordsets as MssqlRecordset[]) ?? [];
  const mapSet = (rs: MssqlRecordset): QueryResult => {
    const truncated = rs.length > maxRows;
    const rows = truncated ? rs.slice(0, maxRows) : [...rs];
    const columns = Object.entries(rs.columns ?? {})
      .sort(([, a], [, b]) => a.index - b.index)
      .map(([name, meta]) => ({ name, type: meta.type?.name ?? '' }));
    return { columns, rows, rowCount: rows.length, truncated, elapsedMs: 0 };
  };

  const sets = recordsets.map(mapSet);
  const affected = result.rowsAffected?.reduce((a, b) => a + b, 0);
  const first = sets[0] ?? { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 };
  first.elapsedMs = elapsedMs;
  if (sets.length === 0 && affected !== undefined && affected > 0) first.affectedRows = affected;
  if (sets.length > 1) first.resultSets = sets.slice(1);
  return first;
}

/** Parses mssql:// URLs into config fields. */
export function parseMssqlUrl(url: string): Record<string, unknown> {
  const parsed = new URL(url);
  const out: Record<string, unknown> = {};
  if (parsed.hostname) out['server'] = parsed.hostname;
  if (parsed.port) out['port'] = Number(parsed.port);
  if (parsed.username) out['user'] = decodeURIComponent(parsed.username);
  if (parsed.password) out['password'] = decodeURIComponent(parsed.password);
  const database = parsed.pathname.replace(/^\//, '');
  if (database) out['database'] = database;
  return out;
}

/** Extracts host/port/database from an ADO-style connection string. */
export function parseAdoConnectionString(cs: string): Endpoint {
  const get = (names: string[]): string | undefined => {
    for (const name of names) {
      const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]+)`, 'i').exec(cs);
      if (m?.[1]) return m[1].trim();
    }
    return undefined;
  };
  const serverRaw = get(['Server', 'Data Source', 'Address']);
  let host: string | undefined;
  let port: number | undefined;
  if (serverRaw) {
    // Forms: host | host,port | tcp:host,port
    const noProto = serverRaw.replace(/^tcp:/i, '');
    const [h, p] = noProto.split(',');
    host = h?.trim() || undefined;
    if (p && !Number.isNaN(Number(p.trim()))) port = Number(p.trim());
  }
  return { host, port, database: get(['Database', 'Initial Catalog']) };
}

/** Rewrites the Server= part of an ADO connection string to a new endpoint. */
export function overrideAdoServer(cs: string, host: string, port: number): string {
  const re = /((?:^|;)\s*(?:Server|Data Source|Address)\s*=\s*)([^;]+)/i;
  if (re.test(cs)) return cs.replace(re, `$1${host},${port}`);
  return `Server=${host},${port};${cs}`;
}

export class MssqlDbPool implements DbPool {
  private ended = false;

  constructor(private readonly pool: sql.ConnectionPool) {}

  async query(sqlText: string, opts: QueryOptions): Promise<QueryResult> {
    const request = this.pool.request();
    const started = Date.now();
    let timedOut = false;
    // mssql has no per-request timeout: cancel the in-flight request ourselves.
    const timer = setTimeout(() => {
      timedOut = true;
      request.cancel();
    }, Math.max(1, Math.floor(opts.timeoutMs)));
    try {
      const result = await request.query(sqlText);
      return mapMssqlResult(result as never, opts.maxRows, Date.now() - started);
    } catch (err) {
      if (timedOut && (err as { code?: string }).code === MSSQL_CANCEL_CODE) throw err;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * SHOWPLAN_XML must be the only statement of its own batch and applies per
   * session — a transaction pins one pooled connection for all three batches.
   * With SHOWPLAN ON the query is compiled, not executed.
   */
  async explain(sqlText: string, opts: QueryOptions): Promise<QueryResult> {
    const transaction = this.pool.transaction();
    await transaction.begin();
    const started = Date.now();
    // No per-request timeout in mssql: cancel whichever batch is in flight when
    // the deadline hits (SHOWPLAN compilation of a huge plan can hang for ages).
    let current: sql.Request | undefined;
    const timer = setTimeout(() => current?.cancel(), Math.max(1, Math.floor(opts.timeoutMs)));
    const run = <T>(fn: (request: sql.Request) => Promise<T>): Promise<T> => {
      current = transaction.request();
      return fn(current);
    };
    try {
      await run((request) => request.batch('SET SHOWPLAN_XML ON'));
      const result = await run((request) => request.query(sqlText));
      await run((request) => request.batch('SET SHOWPLAN_XML OFF'));
      await transaction.commit();
      return mapMssqlResult(result as never, opts.maxRows, Date.now() - started);
    } catch (err) {
      try {
        await transaction.rollback();
      } catch {
        /* connection may be gone */
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async ping(): Promise<void> {
    await this.pool.request().query('SELECT 1');
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.pool.close();
  }
}

export class MssqlDriver implements DialectDriver {
  readonly dialect: string = 'mssql';
  readonly explainFormat: 'json' | 'text' = 'text';

  constructor(private readonly logger: Logger) {}

  defaultPort(): number {
    return 1433;
  }

  extractEndpoint(options: Record<string, unknown>): Endpoint {
    const cs = options['connectionString'];
    if (typeof cs === 'string') {
      if (/^mssql:\/\//i.test(cs)) {
        try {
          const parsed = parseMssqlUrl(cs);
          return {
            host: parsed['server'] as string | undefined,
            port: parsed['port'] as number | undefined,
            database: parsed['database'] as string | undefined,
          };
        } catch {
          return {};
        }
      }
      return parseAdoConnectionString(cs);
    }
    const host = options['server'] ?? options['host'];
    return {
      host: typeof host === 'string' ? host : undefined,
      port: options['port'] !== undefined && options['port'] !== null ? Number(options['port']) : undefined,
      database: typeof options['database'] === 'string' ? options['database'] : undefined,
    };
  }

  async createPool(input: CreatePoolInput): Promise<DbPool> {
    const logger = this.logger.child({ connection: input.key });
    if (input.config.read_only) {
      logger.warn(
        'read_only requested: SQL Server has no session-level read-only mode; readOnlyIntent is set ' +
          '(effective only on AG read replicas) — use a read-only database user for real enforcement',
      );
    }
    const pool = new sql.ConnectionPool(this.buildPoolConfig(input));
    await pool.connect();
    pool.on('error', (err) => logger.warn('mssql pool error', { err }));
    return new MssqlDbPool(pool);
  }

  private buildPoolConfig(input: CreatePoolInput): sql.config {
    let base: Record<string, unknown> = { ...input.renderedOptions };
    const cs = base['connectionString'];
    if (typeof cs === 'string') {
      if (/^mssql:\/\//i.test(cs)) {
        base = { ...parseMssqlUrl(cs), ...base };
        delete base['connectionString'];
      } else if (input.endpoint) {
        // ADO string + tunnel: rewrite the Server= part to the local endpoint.
        return {
          ...(this.parseWithDriver(overrideAdoServer(cs, input.endpoint.host, input.endpoint.port)) as sql.config),
          ...this.poolSection(input),
        };
      } else {
        return { ...(this.parseWithDriver(cs) as sql.config), ...this.poolSection(input) };
      }
    }
    // Accept "host" as an alias for mssql's "server".
    if (base['host'] !== undefined && base['server'] === undefined) base['server'] = base['host'];
    delete base['host'];
    if (input.endpoint) {
      base['server'] = input.endpoint.host;
      base['port'] = input.endpoint.port;
    }
    if (base['port'] !== undefined && base['port'] !== null) base['port'] = Number(base['port']);
    const options = {
      ...(base['options'] as Record<string, unknown> | undefined),
      ...(input.config.read_only ? { readOnlyIntent: true } : {}),
    };
    return {
      ...(base as unknown as sql.config),
      options: options,
      ...this.poolSection(input),
    };
  }

  private poolSection(input: CreatePoolInput): Partial<sql.config> {
    return {
      pool: {
        max: input.pool.max,
        min: input.pool.min,
        idleTimeoutMillis: input.pool.idle_timeout_ms,
      },
      connectionTimeout: input.pool.connection_timeout_ms,
      // Our per-query cancel() fires first; this is only a server-side backstop.
      requestTimeout: 3_600_000,
    };
  }

  private parseWithDriver(connectionString: string): unknown {
    // mssql can parse ADO connection strings itself.
    return sql.ConnectionPool.parseConnectionString(connectionString);
  }

  buildExplainSql(query: string): string {
    // Not used: MssqlDbPool implements explain() (SHOWPLAN_XML needs its own batches).
    return query;
  }

  serverInfoSql(): string {
    return 'SELECT @@VERSION AS [version], SUSER_SNAME() AS [user], DB_NAME() AS [database]';
  }

  classifyError(err: unknown): ErrorClass {
    const e = err as { code?: string; name?: string } | undefined;
    if (!e) return 'unknown';
    const code = e.code ?? '';
    if (code === 'ELOGIN') return 'auth';
    if (code === MSSQL_CANCEL_CODE) return 'query';
    if (SYSCALL_CODES.has(code) || CONNECTION_CODES.has(code)) return 'connection';
    if (code === 'ETIMEOUT') return e.name === 'ConnectionError' ? 'connection' : 'query';
    if (code !== '') return 'query';
    return 'unknown';
  }

  isTimeoutError(err: unknown): boolean {
    return (err as { code?: string } | undefined)?.code === MSSQL_CANCEL_CODE;
  }
}
