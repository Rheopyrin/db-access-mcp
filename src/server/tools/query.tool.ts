import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import type { ConfigService } from '../../config/config.service';
import { resolveDatabase } from '../../config/database-select';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import type { QueryExecutor } from '../../pools/execute';
import { errorResult, okResult } from '../results';

export class QueryTool implements McpTool {
  readonly name = 'query';
  readonly description =
    'Execute a SQL query on a configured connection (use connection_list to discover keys). ' +
    'Results are truncated to max_rows (default from config, typically 1000) with truncated=true set; ' +
    'add LIMIT for large tables. Connections marked read_only reject writes at the session level. ' +
    'Multi-statement scripts are passed to the driver as-is (for mysql they require multipleStatements ' +
    'enabled in the connection options).';
  readonly inputSchema: ZodRawShape = {
    connection: z.string().describe('Connection key from connection_list'),
    database: z
      .string()
      .optional()
      .describe('Database to run against; required when the connection declares multiple databases'),
    query: z.string().describe('SQL text to execute'),
    max_rows: z.number().int().min(1).max(100_000).optional().describe('Row cap for this call (overrides config)'),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(600_000)
      .optional()
      .describe('Query timeout in ms for this call (overrides config)'),
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly executor: QueryExecutor,
    private readonly logger: Logger,
  ) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const connectionKey = args['connection'] as string;
      const sql = args['query'] as string;
      const database = resolveDatabase(
        connectionKey,
        this.configService.getConnection(connectionKey),
        args['database'] as string | undefined,
      );
      const limits = this.configService.effectiveLimits(connectionKey);
      const maxRows = (args['max_rows'] as number | undefined) ?? limits.max_rows;
      const timeoutMs = (args['timeout_ms'] as number | undefined) ?? limits.query_timeout_ms;

      const result = await this.executor.execute(connectionKey, (pool) => pool.query(sql, { maxRows, timeoutMs }), {
        database,
      });
      return okResult({ ...(result as unknown as Record<string, unknown>), ...(database ? { database } : {}) });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}
