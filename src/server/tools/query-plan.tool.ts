import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import type { DialectRegistry } from '../../composition/registries';
import type { ConfigService } from '../../config/config.service';
import { resolveDatabase } from '../../config/database-select';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import type { QueryResult } from '../../interfaces/dialect-driver';
import type { QueryExecutor } from '../../pools/execute';
import { errorResult, okResult } from '../results';

export class QueryPlanTool implements McpTool {
  readonly name = 'query_plan';
  readonly description =
    'Get the execution plan (EXPLAIN) for a SQL query without running it. ' +
    'postgres/mysql return a JSON plan; redshift returns a text plan (Redshift supports neither ' +
    'FORMAT JSON nor EXPLAIN ANALYZE, and its cost numbers are relative — do not compare them to postgres costs).';
  readonly inputSchema: ZodRawShape = {
    connection: z.string().describe('Connection key from connection_list'),
    database: z
      .string()
      .optional()
      .describe('Database to explain against; required when the connection declares multiple databases'),
    query: z.string().describe('SQL text to explain (the query itself is not executed)'),
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly dialects: DialectRegistry,
    private readonly executor: QueryExecutor,
    private readonly logger: Logger,
  ) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const connectionKey = args['connection'] as string;
      const sql = args['query'] as string;
      const conn = this.configService.getConnection(connectionKey);
      const database = resolveDatabase(connectionKey, conn, args['database'] as string | undefined);
      const driver = this.dialects.get(conn.type);
      const limits = this.configService.effectiveLimits(connectionKey);
      const opts = { maxRows: 10_000, timeoutMs: limits.query_timeout_ms };

      let format: 'json' | 'text' = driver.explainFormat;
      let result: QueryResult;
      try {
        result = await this.executor.execute(
          connectionKey,
          (pool) => (pool.explain ? pool.explain(sql, opts) : pool.query(driver.buildExplainSql(sql), opts)),
          { database },
        );
      } catch (err) {
        if (format !== 'json') throw err;
        // Some servers/versions reject FORMAT JSON — fall back to a plain text plan.
        this.logger.warn('json explain failed; falling back to text explain', { connection: connectionKey });
        format = 'text';
        result = await this.executor.execute(connectionKey, (pool) => pool.query(`EXPLAIN ${sql}`, opts), { database });
      }

      return okResult({ format, plan: extractPlan(result, format) });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}

/** Pulls the plan out of the first column of the EXPLAIN result rows. */
export function extractPlan(result: QueryResult, format: 'json' | 'text'): unknown {
  const firstColumn = result.columns[0]?.name;
  const values = result.rows.map((row) => (firstColumn !== undefined ? row[firstColumn] : Object.values(row)[0]));
  if (format === 'text') {
    return values.map((v) => String(v)).join('\n');
  }
  const first = values[0];
  if (typeof first === 'string') {
    try {
      return JSON.parse(first); // mysql returns the JSON plan as a string
    } catch {
      return first;
    }
  }
  return first ?? null; // pg parses the json column into an object already
}
