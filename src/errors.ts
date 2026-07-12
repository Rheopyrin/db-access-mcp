export type DbAccessErrorCode =
  | 'CONFIG_INVALID'
  | 'CONNECTION_NOT_FOUND'
  | 'DATABASE_NOT_FOUND'
  | 'SECRET_RESOLUTION_FAILED'
  | 'TUNNEL_FAILED'
  | 'CONNECTION_FAILED'
  | 'QUERY_FAILED'
  | 'QUERY_TIMEOUT';

export interface DbAccessErrorOptions {
  hint?: string;
  cause?: unknown;
}

/**
 * The only error type MCP tools expose to the client. `message` and `hint`
 * must never contain credentials or rendered connection options.
 */
export class DbAccessError extends Error {
  readonly code: DbAccessErrorCode;
  readonly hint?: string;

  constructor(code: DbAccessErrorCode, message: string, options: DbAccessErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DbAccessError';
    this.code = code;
    this.hint = options.hint;
  }
}

export function isDbAccessError(err: unknown): err is DbAccessError {
  return err instanceof DbAccessError;
}
