import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import type { DialectRegistry } from '../../composition/registries';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import { errorResult, okResult } from '../results';

export class DialectListTool implements McpTool {
  readonly name = 'dialect_list';
  readonly description =
    'List the database dialects this server supports. Returns each dialect name (usable as the "type" ' +
    'field of a connection in the config), its default port and the execution-plan format produced by query_plan.';
  readonly inputSchema: ZodRawShape = {};

  constructor(
    private readonly dialects: DialectRegistry,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<CallToolResult> {
    try {
      const dialects = this.dialects.keys().map((key) => {
        const driver = this.dialects.get(key);
        return {
          dialect: driver.dialect,
          default_port: driver.defaultPort(),
          explain_format: driver.explainFormat,
        };
      });
      return okResult({ dialects });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}
