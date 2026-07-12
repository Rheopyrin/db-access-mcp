import type { ConnectionConfig, PoolSettings } from '../config/schema';

export interface QueryOptions {
  maxRows: number;
  timeoutMs: number;
}

export interface QueryResult {
  columns: { name: string; type?: string }[];
  rows: Record<string, unknown>[];
  /** Rows returned after truncation. */
  rowCount: number;
  /** Rows affected by DML, when the driver reports it. */
  affectedRows?: number;
  truncated: boolean;
  elapsedMs: number;
  /** Additional result sets for multi-statement queries. */
  resultSets?: QueryResult[];
}

export interface StreamResult {
  columns: { name: string; type?: string }[];
  rowCount: number;
}

export interface DbPool {
  query(sql: string, opts: QueryOptions): Promise<QueryResult>;
  /**
   * Dialect-specific EXPLAIN when a wrapped SQL string is not enough
   * (e.g. mssql SHOWPLAN_XML needs its own batches on a pinned session).
   * When absent, the driver's buildExplainSql() output is run via query().
   */
  explain?(sql: string, opts: QueryOptions): Promise<QueryResult>;
  /**
   * Streams rows without buffering the whole result (large exports).
   * Implemented for postgres (pg-cursor) and mysql (mysql2 stream); dialects
   * without it fall back to a buffered, row-capped query().
   */
  queryStream?(
    sql: string,
    opts: { timeoutMs: number },
    onRow: (row: Record<string, unknown>) => Promise<void> | void,
  ): Promise<StreamResult>;
  /** Cheap health probe (SELECT 1). */
  ping(): Promise<void>;
  /** Graceful drain; must be idempotent. */
  end(): Promise<void>;
}

export interface CreatePoolInput {
  key: string;
  config: ConnectionConfig;
  /** Options with secret placeholders already rendered. */
  renderedOptions: Record<string, unknown>;
  pool: Required<PoolSettings>;
  /** Local tunnel endpoint overriding host/port from options. */
  endpoint?: { host: string; port: number };
}

export type ErrorClass = 'connection' | 'auth' | 'query' | 'unknown';

export interface Endpoint {
  host?: string;
  port?: number;
  database?: string;
}

export interface DialectDriver {
  readonly dialect: string;
  /** Format produced by buildExplainSql: parsed JSON plan or plain text. */
  readonly explainFormat: 'json' | 'text';
  createPool(input: CreatePoolInput): Promise<DbPool>;
  buildExplainSql(query: string): string;
  /** One-row query yielding { version, user, database } for connection_test. */
  serverInfoSql(): string;
  classifyError(err: unknown): ErrorClass;
  isTimeoutError(err: unknown): boolean;
  defaultPort(): number;
  /** Extracts host/port/database from driver options (incl. connection strings). */
  extractEndpoint(options: Record<string, unknown>): Endpoint;
}
