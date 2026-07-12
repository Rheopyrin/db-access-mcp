import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpTool } from '../interfaces/mcp-tool';
import { VERSION } from '../version';

export function createMcpServer(tools: readonly McpTool[]): McpServer {
  const server = new McpServer({ name: 'db-access-mcp', version: VERSION });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      (args: Record<string, unknown>) => tool.execute(args ?? {}),
    );
  }
  return server;
}
