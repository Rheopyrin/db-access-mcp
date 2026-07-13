import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildContainer } from '../composition/container';
import { type DialectRegistry } from '../composition/registries';
import { TYPES } from '../composition/types';
import type { ConfigService } from '../config/config.service';
import { InstanceRegistry } from '../instances/instance-registry';
import { sweepDeadInstances } from '../instances/sweep';
import type { Logger } from '../interfaces/logger';
import type { McpTool } from '../interfaces/mcp-tool';
import type { QueryExecutor } from '../pools/execute';
import { IdleReaper } from '../pools/idle-reaper';
import type { PoolManager } from '../pools/pool-manager';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { TunnelManager } from '../tunnels/tunnel-manager';
import { ShutdownManager } from '../shutdown';
import { createMcpServer } from './server';
import { VERSION } from '../version';

export interface BootstrapOptions {
  /** Workdir: config.json, conf.d/, instances/, sso/. */
  workdir: string;
  /** Export dir: where query_to_file writes exports. */
  exportDir: string;
  configService: ConfigService;
  logger: Logger;
}

export async function startServer(options: BootstrapOptions): Promise<void> {
  const { workdir, exportDir, configService, logger } = options;
  const container = buildContainer({ workdir, exportDir, configService, logger });

  // Fail fast on connections referencing unregistered dialects.
  const dialects = container.get<DialectRegistry>(TYPES.DialectRegistry);
  for (const key of configService.connectionKeys()) {
    dialects.get(configService.getConnection(key).type);
  }

  // The export directory is NOT created here — query_to_file makes it on demand.

  // Clean up tunnels orphaned by crashed instances, then register ourselves.
  await sweepDeadInstances(workdir, logger).catch((err: unknown) => {
    logger.warn('startup sweep failed', { err });
  });
  const sweepTimer = setInterval(() => {
    void sweepDeadInstances(workdir, logger).catch((err: unknown) => logger.warn('periodic sweep failed', { err }));
  }, 600_000);
  sweepTimer.unref();

  const instanceRegistry = new InstanceRegistry(workdir, logger);
  instanceRegistry.init();

  const shutdown = new ShutdownManager(logger);
  const secretsManager = container.get<SecretsManager>(TYPES.SecretsManager);
  const poolManager = container.get<PoolManager>(TYPES.PoolManager);
  const tunnelManager = container.get<TunnelManager>(TYPES.TunnelManager);
  poolManager.setConnectionTunnels(tunnelManager);
  container.get<QueryExecutor>(TYPES.QueryExecutor).setConnectionTunnels(tunnelManager);
  tunnelManager.setRegistrar(instanceRegistry);
  const idleReaper = new IdleReaper(configService, poolManager, logger);
  idleReaper.start();

  shutdown.register('idle-reaper', () => idleReaper.stop());
  shutdown.register('secrets', () => secretsManager.dispose());
  shutdown.register('pools', () => poolManager.closeAll());
  shutdown.register('tunnels', () => tunnelManager.closeAll());
  shutdown.register('instance-file', () => instanceRegistry.delete());

  const tools = container.getAll<McpTool>(TYPES.McpTool);
  const server = createMcpServer(tools);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    logger.info('stdio transport closed; shutting down');
    void shutdown.run().then(() => process.exit(0));
  };
  // The SDK server transport only listens for 'data': stdin EOF (client went
  // away) would otherwise drain the event loop and exit without cleanup.
  process.stdin.on('end', () => {
    logger.info('stdin closed; shutting down');
    void shutdown.run().then(() => process.exit(0));
  });
  // Belt and braces for any natural exit path: the instance file can (and
  // must) be removed synchronously. SIGKILL is covered by the startup sweep.
  process.on('exit', () => instanceRegistry.delete());
  shutdown.installSignalHandlers();

  await server.connect(transport);
  logger.info('db-access-mcp started', {
    version: VERSION,
    pid: process.pid,
    tools: tools.map((t) => t.name),
  });
}
