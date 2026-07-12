import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodRawShape;
  execute(args: Record<string, unknown>): Promise<CallToolResult>;
}
