import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import type { DialectRegistry } from '../../composition/registries';
import type { ConfigService } from '../../config/config.service';
import { DbAccessError } from '../../errors';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import type { TunnelManager } from '../../tunnels/tunnel-manager';
import type { SecretsManager } from '../../secrets/secrets-manager';
import { errorResult, okResult } from '../results';

export class UpTunnelTool implements McpTool {
  readonly name = 'up_tunnel';
  readonly description =
    'Open (or reuse) the tunnel configured for a connection WITHOUT connecting to the database. ' +
    'Returns the local host/port to connect through and a tunnel_id for down_tunnel. The tunnel is ' +
    'closed by down_tunnel, on idle timeout or when this MCP instance exits. Pass local_port to bind ' +
    'an exact local port; this fails if the tunnel is already open on a different port or the port is taken.';
  readonly inputSchema: ZodRawShape = {
    connection: z.string().describe('Connection key from connection_list (must have a tunnel configured)'),
    local_port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe('Exact local port to open the tunnel on (default: port from the config or a random free one)'),
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly dialects: DialectRegistry,
    private readonly secretsManager: SecretsManager,
    private readonly tunnelManager: TunnelManager,
    private readonly logger: Logger,
  ) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const connectionKey = args['connection'] as string;
      const conn = this.configService.getConnection(connectionKey);
      if (!conn.tunnel) {
        throw new DbAccessError('CONFIG_INVALID', `connection "${connectionKey}" has no tunnel configured`, {
          hint: 'Add a "tunnel" section to the connection or use a connection that has one.',
        });
      }
      const driver = this.dialects.get(conn.type);
      const { options } = await this.secretsManager.getRenderedOptions(connectionKey);
      const remote = driver.extractEndpoint(options);
      if (!remote.host) {
        throw new DbAccessError(
          'CONFIG_INVALID',
          `connection "${connectionKey}": cannot determine the remote database host from "options"`,
        );
      }

      const endpoint = await this.tunnelManager.ensure(
        connectionKey,
        { host: remote.host, port: remote.port ?? driver.defaultPort() },
        { requestedLocalPort: args['local_port'] as number | undefined, pin: true },
      );
      return okResult({
        host: endpoint.host,
        port: endpoint.port,
        tunnel_id: endpoint.id,
        reused: endpoint.reused,
        tunnel: conn.tunnel.target,
      });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}
