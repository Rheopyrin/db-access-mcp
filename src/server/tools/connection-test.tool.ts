import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import type { DialectRegistry } from '../../composition/registries';
import type { ConfigService } from '../../config/config.service';
import { resolveDatabase } from '../../config/database-select';
import { isDbAccessError } from '../../errors';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import type { QueryExecutor } from '../../pools/execute';
import { errorResult, okResult } from '../results';

const TEST_TIMEOUT_MS = 10_000;

export class ConnectionTestTool implements McpTool {
  readonly name = 'connection_test';
  readonly description =
    'Test a configured connection end-to-end: resolves secrets, opens the tunnel if configured, ' +
    'connects and runs a one-row server-info query. Returns ok=true with server version, user, ' +
    'database and latency — or ok=false with the failure code and hint (an unreachable database is ' +
    'a valid test result, not a tool error).';
  readonly inputSchema: ZodRawShape = {
    connection: z.string().describe('Connection key from connection_list'),
    database: z
      .string()
      .optional()
      .describe('Database to test; required when the connection declares multiple databases'),
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly dialects: DialectRegistry,
    private readonly executor: QueryExecutor,
    private readonly logger: Logger,
  ) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    const connectionKey = args['connection'] as string;
    let conn;
    try {
      conn = this.configService.getConnection(connectionKey);
    } catch (err) {
      // Unknown connection key is a caller mistake, not a test result.
      return errorResult(err, this.logger, this.name);
    }

    const started = Date.now();
    try {
      const database = resolveDatabase(connectionKey, conn, args['database'] as string | undefined);
      const driver = this.dialects.get(conn.type);
      const result = await this.executor.execute(
        connectionKey,
        (pool) => pool.query(driver.serverInfoSql(), { maxRows: 1, timeoutMs: TEST_TIMEOUT_MS }),
        { database },
      );
      const row = result.rows[0] ?? {};
      const asText = (v: unknown): string =>
        typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v);
      return okResult({
        ok: true,
        connection: connectionKey,
        elapsed_ms: Date.now() - started,
        server_version: asText(row['version']),
        user: asText(row['user']),
        database: asText(row['database']),
        via_tunnel: conn.tunnel !== undefined,
        read_only_configured: conn.read_only,
      });
    } catch (err) {
      this.logger.warn('connection test failed', { connection: connectionKey, err });
      return okResult({
        ok: false,
        connection: connectionKey,
        elapsed_ms: Date.now() - started,
        error: {
          code: isDbAccessError(err) ? err.code : 'UNKNOWN',
          message: (err as Error).message,
          ...(isDbAccessError(err) && err.hint ? { hint: err.hint } : {}),
        },
      });
    }
  }
}
