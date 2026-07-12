import pg from 'pg';
import { parse as parseConnectionString } from 'pg-connection-string';
import Cursor from 'pg-cursor';
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

const STREAM_BATCH_SIZE = 1_000;

const SYSCALL_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']);
const CONNECTION_MESSAGE_RE = /connection terminated|timeout expired|client has encountered a connection error/i;

export function mapPgResult(result: pg.QueryResult, maxRows: number): QueryResult {
  const rows = (result.rows ?? []) as Record<string, unknown>[];
  const truncated = rows.length > maxRows;
  const sliced = truncated ? rows.slice(0, maxRows) : rows;
  const isDml = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(result.command);
  return {
    columns: (result.fields ?? []).map((f) => ({ name: f.name, type: String(f.dataTypeID) })),
    rows: sliced,
    rowCount: sliced.length,
    affectedRows: isDml ? (result.rowCount ?? undefined) : undefined,
    truncated,
    elapsedMs: 0,
  };
}

export function mapPgResults(result: pg.QueryResult | pg.QueryResult[], maxRows: number, elapsedMs: number): QueryResult {
  const list = Array.isArray(result) ? result : [result];
  const mapped = list.map((r) => mapPgResult(r, maxRows));
  const first = mapped[0] ?? {
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    elapsedMs,
  };
  first.elapsedMs = elapsedMs;
  if (mapped.length > 1) first.resultSets = mapped.slice(1);
  return first;
}

type ReadonlyMode = 'off' | 'enforce' | 'best_effort';

class PgDbPool implements DbPool {
  private readonlyMode: ReadonlyMode;
  private ended = false;
  /** Defined only when the dialect supports cursor streaming (not Redshift). */
  readonly queryStream?: DbPool['queryStream'];

  constructor(
    private readonly pool: pg.Pool,
    readonlyMode: ReadonlyMode,
    supportsStreaming: boolean,
    private readonly allowMultiStatements: boolean,
    private readonly logger: Logger,
  ) {
    this.readonlyMode = readonlyMode;
    if (supportsStreaming) {
      this.queryStream = (sql, opts, onRow) => this.cursorStream(sql, opts, onRow);
    }
    // An idle client emitting an error would otherwise crash the process.
    pool.on('error', (err) => this.logger.warn('idle pool client error', { err }));
  }

  async query(sql: string, opts: QueryOptions): Promise<QueryResult> {
    const client = await this.pool.connect();
    const started = Date.now();
    let broken: Error | undefined;
    try {
      await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`);
      await this.applyReadonly(client);
      // With multi-statement disabled, force the extended protocol
      // (queryMode: 'extended', unnamed statement — no prepared-statement
      // accumulation): the server rejects >1 statement with 42601, so no SQL
      // splitting on our side and no `SET read_only=off; INSERT` bypass.
      // queryMode is a runtime pg feature not yet in @types/pg.
      const extendedConfig = { text: sql, queryMode: 'extended' } as unknown as pg.QueryConfig;
      const result = (await (this.allowMultiStatements ? client.query(sql) : client.query(extendedConfig))) as
        | pg.QueryResult
        | pg.QueryResult[];
      return mapPgResults(result, opts.maxRows, Date.now() - started);
    } catch (err) {
      // Destroy the client on failure: its session state may be poisoned.
      broken = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      client.release(broken);
    }
  }

  private async applyReadonly(client: pg.PoolClient): Promise<void> {
    if (this.readonlyMode === 'off') return;
    try {
      await client.query('SET default_transaction_read_only = on');
    } catch (err) {
      if (this.readonlyMode === 'enforce') throw err;
      // Redshift: parameter not supported — warn once and stop trying.
      this.logger.warn(
        'read_only requested but the server does not support default_transaction_read_only; use a read-only database user',
        { err },
      );
      this.readonlyMode = 'off';
    }
  }

  /** Cursor-based streaming (extended protocol): single statement only. */
  private async cursorStream(
    sql: string,
    opts: { timeoutMs: number },
    onRow: (row: Record<string, unknown>) => Promise<void> | void,
  ): Promise<StreamResult> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(`SET statement_timeout = ${Math.max(1, Math.floor(opts.timeoutMs))}`);
      await this.applyReadonly(client);
      const cursor = client.query(new Cursor(sql));
      let columns: StreamResult['columns'] | undefined;
      let rowCount = 0;
      try {
        for (;;) {
          const rows = (await cursor.read(STREAM_BATCH_SIZE)) as Record<string, unknown>[];
          if (rows.length === 0) break;
          columns ??= Object.keys(rows[0] ?? {}).map((name) => ({ name }));
          for (const row of rows) {
            await onRow(row);
            rowCount += 1;
          }
        }
      } finally {
        await cursor.close().catch(() => undefined);
      }
      return { columns: columns ?? [], rowCount };
    } catch (err) {
      broken = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      client.release(broken);
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

export class PostgresDriver implements DialectDriver {
  readonly dialect: string = 'postgres';
  readonly explainFormat: 'json' | 'text' = 'json';

  constructor(protected readonly logger: Logger) {}

  defaultPort(): number {
    return 5432;
  }

  /** How read_only sessions are applied; Redshift downgrades to best-effort. */
  protected readonlyMode(): 'enforce' | 'best_effort' {
    return 'enforce';
  }

  /** Cursor streaming; Redshift disables it (extended-protocol cursors are unreliable there). */
  protected supportsStreaming(): boolean {
    return true;
  }

  extractEndpoint(options: Record<string, unknown>): Endpoint {
    if (typeof options['connectionString'] === 'string') {
      try {
        const parsed = parseConnectionString(options['connectionString']);
        return {
          host: parsed.host ?? undefined,
          port: parsed.port ? Number(parsed.port) : undefined,
          database: parsed.database ?? undefined,
        };
      } catch {
        return {};
      }
    }
    return {
      host: typeof options['host'] === 'string' ? options['host'] : undefined,
      port: options['port'] !== undefined && options['port'] !== null ? Number(options['port']) : undefined,
      database: typeof options['database'] === 'string' ? options['database'] : undefined,
    };
  }

  protected buildPoolConfig(input: CreatePoolInput): pg.PoolConfig {
    let base: Record<string, unknown> = { ...input.renderedOptions };
    if (typeof base['connectionString'] === 'string') {
      // Parse the connection string ourselves so tunnel endpoint overrides win deterministically.
      const parsed = parseConnectionString(base['connectionString']) as unknown as Record<string, unknown>;
      delete base['connectionString'];
      base = { ...parsed, ...base };
    }
    if (input.endpoint) {
      base['host'] = input.endpoint.host;
      base['port'] = input.endpoint.port;
    }
    if (base['port'] !== undefined && base['port'] !== null) base['port'] = Number(base['port']);
    return {
      ...base,
      max: input.pool.max,
      min: input.pool.min,
      idleTimeoutMillis: input.pool.idle_timeout_ms,
      connectionTimeoutMillis: input.pool.connection_timeout_ms,
    };
  }

  async createPool(input: CreatePoolInput): Promise<DbPool> {
    const pool = new pg.Pool(this.buildPoolConfig(input));
    const mode: ReadonlyMode = input.config.read_only ? this.readonlyMode() : 'off';
    // Only an explicit `true` enables multi-statement; otherwise the extended
    // protocol makes the server reject >1 statement.
    const allowMultiStatements = input.renderedOptions['multipleStatements'] === true;
    return new PgDbPool(
      pool,
      mode,
      this.supportsStreaming(),
      allowMultiStatements,
      this.logger.child({ connection: input.key }),
    );
  }

  buildExplainSql(query: string): string {
    return `EXPLAIN (FORMAT JSON) ${query}`;
  }

  serverInfoSql(): string {
    return 'SELECT version() AS version, current_user AS "user", current_database() AS "database"';
  }

  classifyError(err: unknown): ErrorClass {
    const e = err as { code?: string; message?: string } | undefined;
    if (!e) return 'unknown';
    const code = e.code ?? '';
    if (SYSCALL_CODES.has(code)) return 'connection';
    if (code.startsWith('08')) return 'connection'; // SQLSTATE class 08: connection exception
    if (code === '57P01' || code === '57P02' || code === '57P03') return 'connection'; // shutdown/crash/cannot-connect
    if (code === '28000' || code === '28P01') return 'auth';
    if (typeof e.message === 'string' && CONNECTION_MESSAGE_RE.test(e.message)) return 'connection';
    if (code !== '') return 'query';
    return 'unknown';
  }

  isTimeoutError(err: unknown): boolean {
    return (err as { code?: string } | undefined)?.code === '57014'; // canceling statement due to statement timeout
  }
}
