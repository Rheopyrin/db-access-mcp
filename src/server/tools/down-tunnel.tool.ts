import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import type { PoolManager } from '../../pools/pool-manager';
import type { TunnelManager } from '../../tunnels/tunnel-manager';
import { errorResult, okResult } from '../results';

export class DownTunnelTool implements McpTool {
  readonly name = 'down_tunnel';
  readonly description =
    'Close a tunnel previously opened with up_tunnel, by its tunnel_id. By default only the up_tunnel ' +
    'pin is released: if live connection pools still use the tunnel it stays open and their keys are ' +
    'returned in remaining_holders. With force=true the holder pools are drained and the tunnel is ' +
    'closed unconditionally (the next query recreates them).';
  readonly inputSchema: ZodRawShape = {
    tunnel_id: z.string().describe('Tunnel id returned by up_tunnel'),
    force: z.boolean().optional().describe('Drain holder pools and close the tunnel unconditionally'),
  };

  constructor(
    private readonly tunnelManager: TunnelManager,
    private readonly poolManager: PoolManager,
    private readonly logger: Logger,
  ) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const tunnelId = args['tunnel_id'] as string;
      const force = (args['force'] as boolean | undefined) ?? false;

      if (force) {
        // Drain holder pools first so no live pool points at a dead endpoint;
        // the next query rebuilds pool + tunnel through the normal path.
        const holders = this.tunnelManager.poolHolders(tunnelId);
        for (const key of holders) {
          await this.poolManager.closeConnection(key, { releaseTunnel: false });
        }
        await this.tunnelManager.forceClose(tunnelId);
        return okResult({ tunnel_id: tunnelId, closed: true, forced: true, drained_pools: holders });
      }

      const { closed, holders } = await this.tunnelManager.releasePins(tunnelId);
      return okResult({
        tunnel_id: tunnelId,
        closed,
        ...(closed ? {} : { remaining_holders: holders }),
      });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}
