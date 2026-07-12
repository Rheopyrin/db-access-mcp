import type { DialectRegistry } from '../composition/registries';
import type { ConnectionConfig } from '../config/schema';

export interface ConnectionSummary {
  key: string;
  type: string;
  description?: string;
  read_only: boolean;
  host?: string;
  port?: number;
  database?: string;
  /** Additional databases addressable via the tools' "database" parameter. */
  databases?: string[];
  tunnel?: string;
  metadata: Record<string, string | number | boolean>;
}

/**
 * Allowlist-based sanitization: only the fields below are ever copied out of a
 * connection config. Raw (un-rendered) options are used, so secret values are
 * never resolved for listing; connection strings are parsed for host/port/db only.
 */
export function summarizeConnection(
  key: string,
  conn: ConnectionConfig,
  dialects: DialectRegistry,
): ConnectionSummary {
  const endpoint = dialects.has(conn.type)
    ? dialects.get(conn.type).extractEndpoint(conn.options)
    : {};
  const rawDatabases = conn.options['databases'];
  const databases = Array.isArray(rawDatabases)
    ? rawDatabases.filter((d): d is string => typeof d === 'string')
    : [];
  return {
    key,
    type: conn.type,
    ...(conn.description !== undefined ? { description: conn.description } : {}),
    read_only: conn.read_only,
    ...(endpoint.host !== undefined ? { host: endpoint.host } : {}),
    ...(endpoint.port !== undefined && !Number.isNaN(endpoint.port) ? { port: endpoint.port } : {}),
    ...(endpoint.database !== undefined ? { database: endpoint.database } : {}),
    ...(databases.length > 0 ? { databases } : {}),
    ...(conn.tunnel ? { tunnel: conn.tunnel.target } : {}),
    metadata: conn.metadata,
  };
}
