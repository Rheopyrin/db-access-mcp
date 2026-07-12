import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import type { DialectRegistry } from '../../composition/registries';
import type { ConfigService } from '../../config/config.service';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import { errorResult, okResult } from '../results';
import { summarizeConnection, type ConnectionSummary } from '../sanitize';

const IGNORED_FILTERS = ['user', 'username', 'password'] as const;

export class ConnectionFindTool implements McpTool {
  readonly name = 'connection_find';
  readonly description =
    'Find configured database connections by parameters: host, port, database, type, read_only and/or ' +
    'metadata key-value pairs. All provided filters are combined with AND. ' +
    'Username/password filters are ignored. Returns the same sanitized shape as connection_list.';
  readonly inputSchema: ZodRawShape = {
    host: z.string().optional().describe('Exact database host to match'),
    port: z.number().int().optional().describe('Database port to match'),
    database: z.string().optional().describe('Database name to match'),
    type: z.string().optional().describe('Dialect: postgres | mysql | redshift'),
    read_only: z.boolean().optional().describe('Match connections with this read_only setting'),
    metadata: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Metadata key-value pairs; every pair must match (AND)'),
    user: z.string().optional().describe('Ignored: connections are never filtered by credentials'),
    username: z.string().optional().describe('Ignored: connections are never filtered by credentials'),
    password: z.string().optional().describe('Ignored: connections are never filtered by credentials'),
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly dialects: DialectRegistry,
    private readonly logger: Logger,
  ) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const ignored = IGNORED_FILTERS.filter((f) => f in args);
      const filters = {
        host: args['host'] as string | undefined,
        port: args['port'] as number | undefined,
        database: args['database'] as string | undefined,
        type: args['type'] as string | undefined,
        read_only: args['read_only'] as boolean | undefined,
        metadata: args['metadata'] as Record<string, string | number | boolean> | undefined,
      };

      const connections = this.configService
        .connectionKeys()
        .map((key) => summarizeConnection(key, this.configService.getConnection(key), this.dialects))
        .filter((summary) => matches(summary, filters));

      return okResult({
        connections,
        ...(ignored.length > 0 ? { note: `ignored filter(s): ${ignored.join(', ')}` } : {}),
      });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}

function matches(
  summary: ConnectionSummary,
  filters: {
    host?: string;
    port?: number;
    database?: string;
    type?: string;
    read_only?: boolean;
    metadata?: Record<string, string | number | boolean>;
  },
): boolean {
  if (filters.host !== undefined && summary.host !== filters.host) return false;
  if (filters.port !== undefined && summary.port !== filters.port) return false;
  if (
    filters.database !== undefined &&
    summary.database !== filters.database &&
    !(summary.databases?.includes(filters.database) ?? false)
  ) {
    return false;
  }
  if (filters.type !== undefined && summary.type !== filters.type) return false;
  if (filters.read_only !== undefined && summary.read_only !== filters.read_only) return false;
  if (filters.metadata) {
    for (const [k, v] of Object.entries(filters.metadata)) {
      if (summary.metadata[k] !== v) return false;
    }
  }
  return true;
}
