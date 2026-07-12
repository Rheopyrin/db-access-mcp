import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import type { DialectRegistry } from '../../composition/registries';
import type { ConfigService } from '../../config/config.service';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import { errorResult, okResult } from '../results';
import { summarizeConnection } from '../sanitize';

export class ConnectionListTool implements McpTool {
  readonly name = 'connection_list';
  readonly description =
    'List configured database connections (postgres, mysql, redshift). Returns key, type, description, ' +
    'read_only flag, host/port/database and metadata. Credentials are never included. ' +
    'Use the returned key with the query, query_plan and up_tunnel tools.';
  readonly inputSchema: ZodRawShape = {};

  constructor(
    private readonly configService: ConfigService,
    private readonly dialects: DialectRegistry,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<CallToolResult> {
    try {
      const connections = this.configService
        .connectionKeys()
        .map((key) => summarizeConnection(key, this.configService.getConnection(key), this.dialects));
      return okResult({ connections });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}
