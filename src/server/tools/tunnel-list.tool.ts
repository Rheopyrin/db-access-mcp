import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import type { TunnelManager } from '../../tunnels/tunnel-manager';
import { errorResult, okResult } from '../results';

export class TunnelListTool implements McpTool {
  readonly name = 'tunnel_list';
  readonly description =
    'List the tunnels currently open in THIS MCP instance, with a live health probe each. ' +
    'tunnel_id is accepted by down_tunnel; "connections" are the pools holding the tunnel, "pins" are ' +
    'up_tunnel holds. Configured-but-not-open tunnels are visible via connection_list (the tunnel field).';
  readonly inputSchema: ZodRawShape = {};

  constructor(
    private readonly tunnelManager: TunnelManager,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<CallToolResult> {
    try {
      const active = await this.tunnelManager.listActive();
      return okResult({
        tunnels: active.map((t) => ({
          tunnel_id: t.id,
          tunnel: t.tunnelName,
          type: t.tunnelType,
          host: t.localHost,
          port: t.localPort,
          remote_host: t.remote.host,
          remote_port: t.remote.port,
          healthy: t.healthy,
          connections: t.connections,
          pins: t.pins,
          pids: t.externalPids,
        })),
      });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}
