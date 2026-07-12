import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DialectRegistry, SecretProviderRegistry, TunnelProviderRegistry } from '../../src/composition/registries';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { PostgresDriver } from '../../src/dialects/postgres.driver';
import { StderrLogger } from '../../src/logging/logger';
import { QueryExecutor } from '../../src/pools/execute';
import { PoolManager } from '../../src/pools/pool-manager';
import { SecretsManager } from '../../src/secrets/secrets-manager';
import { SshTunnelProvider } from '../../src/tunnels/ssh.provider';
import { TunnelManager } from '../../src/tunnels/tunnel-manager';

const logger = new StderrLogger('silent');

let network: StartedNetwork;
let pgContainer: StartedTestContainer;
let sshContainer: StartedTestContainer;

beforeAll(async () => {
  network = await new Network().start();
  pgContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'testdb' })
    .withNetwork(network)
    .withNetworkAliases('pgdb')
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  sshContainer = await new GenericContainer('testcontainers/sshd:1.2.0')
    .withEnvironment({ PASSWORD: 'root' })
    .withNetwork(network)
    .withExposedPorts(22)
    .start();
}, 240_000);

afterAll(async () => {
  await sshContainer?.stop();
  await pgContainer?.stop();
  await network?.stop();
});

describe('ssh tunnel integration (full path: tunnel -> pool -> query)', () => {
  it('queries postgres through an in-process ssh tunnel', async () => {
    const configService = new ConfigService(
      parseConfig({
        tunnels: {
          bastion: {
            type: 'ssh',
            options: {
              host: sshContainer.getHost(),
              port: sshContainer.getMappedPort(22),
              username: 'root',
              password: 'root',
            },
          },
        },
        connections: {
          pgdb: {
            type: 'postgres',
            // host/port are the REMOTE endpoint as seen from the bastion.
            options: { host: 'pgdb', port: 5432, database: 'testdb', user: 'test', password: 'test' },
            tunnel: { target: 'bastion' },
          },
        },
      }),
    );

    const dialects = new DialectRegistry([new PostgresDriver(logger)]);
    const secretsManager = new SecretsManager(configService, new SecretProviderRegistry([]), logger);
    const tunnelManager = new TunnelManager(
      configService,
      new TunnelProviderRegistry([new SshTunnelProvider(logger)]),
      logger,
    );
    const poolManager = new PoolManager(configService, dialects, secretsManager, logger);
    poolManager.setConnectionTunnels(tunnelManager);
    const executor = new QueryExecutor({
      configService,
      dialects,
      poolManager,
      secretsManager,
      logger,
      tunnels: tunnelManager,
    });

    try {
      const result = await executor.execute('pgdb', (pool) =>
        pool.query('SELECT current_database() AS db', { maxRows: 10, timeoutMs: 10_000 }),
      );
      expect(result.rows).toEqual([{ db: 'testdb' }]);

      expect(await tunnelManager.isHealthy('pgdb')).toBe(true);

      // Second query reuses the same tunnel and pool.
      const again = await executor.execute('pgdb', (pool) =>
        pool.query('SELECT 1 AS ok', { maxRows: 10, timeoutMs: 10_000 }),
      );
      expect(again.rows).toEqual([{ ok: 1 }]);
    } finally {
      await poolManager.closeAll();
      await tunnelManager.closeAll();
      secretsManager.dispose();
    }
    expect(await tunnelManager.isHealthy('pgdb')).toBe(false);
  }, 120_000);
});
