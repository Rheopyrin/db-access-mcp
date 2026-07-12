import { DbAccessError } from '../errors';
import type { ConnectionConfig } from './schema';

export function declaredDatabases(conn: ConnectionConfig): { single?: string; list: string[] } {
  const single = typeof conn.options['database'] === 'string' ? (conn.options['database']) : undefined;
  const raw = conn.options['databases'];
  const list = Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [];
  return { single, list };
}

/** Every database name a connection may address: {database} ∪ databases. */
export function allowedDatabases(conn: ConnectionConfig): string[] {
  const { single, list } = declaredDatabases(conn);
  return [...new Set([...(single ? [single] : []), ...list])];
}

/**
 * Resolves the effective database for a tool call.
 *
 * - no request -> options.database; when the connection declares only a
 *   `databases` list there is no implicit default — DATABASE_NOT_FOUND with
 *   the available names in the hint;
 * - request given -> must be options.database or a member of options.databases.
 *
 * The "neither database nor databases declared" case never reaches this
 * function: it is rejected at config load (connectionString/uri connections
 * carry the database inside the string and skip resolution).
 */
export function resolveDatabase(connectionKey: string, conn: ConnectionConfig, requested?: string): string | undefined {
  const allowed = allowedDatabases(conn);

  if (requested === undefined) {
    const { single } = declaredDatabases(conn);
    if (single) return single;
    if (allowed.length > 0) {
      throw new DbAccessError(
        'DATABASE_NOT_FOUND',
        `connection "${connectionKey}" declares multiple databases; pass the "database" parameter`,
        { hint: `Available databases: ${allowed.join(', ')}.` },
      );
    }
    return undefined; // connectionString/uri connection: database lives in the string
  }

  if (!allowed.includes(requested)) {
    throw new DbAccessError(
      'DATABASE_NOT_FOUND',
      `database "${requested}" is not declared for connection "${connectionKey}"`,
      {
        hint:
          allowed.length > 0
            ? `Available databases: ${allowed.join(', ')}.`
            : 'This connection is defined via a connection string and does not accept a database parameter.',
      },
    );
  }
  return requested;
}
