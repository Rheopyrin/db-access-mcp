import { describe, expect, it, vi } from 'vitest';
import { DialectRegistry, SecretProviderRegistry } from '../../src/composition/registries';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import type {
  CreatePoolInput,
  DbPool,
  DialectDriver,
  Endpoint,
  ErrorClass,
} from '../../src/interfaces/dialect-driver';
import type { ResolvedSecret, SecretProvider } from '../../src/interfaces/secret-provider';
import { StderrLogger } from '../../src/logging/logger';
import { PoolManager } from '../../src/pools/pool-manager';
import { SecretsManager } from '../../src/secrets/secrets-manager';

class FakePool implements DbPool {
  ended = false;
  pinged = 0;
  pingError?: Error;
  constructor(readonly input: CreatePoolInput) {}
  async query() {
    return { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 };
  }
  async ping() {
    this.pinged += 1;
    if (this.pingError) throw this.pingError;
  }
  async end() {
    this.ended = true;
  }
}

class FakeDriver implements DialectDriver {
  readonly dialect = 'postgres';
  readonly explainFormat = 'json' as const;
  createdPools: FakePool[] = [];
  createDelayMs = 0;
  /** When set, the next created pool fails its ping() once (rotation-failure test). */
  nextPoolPingError?: Error;

  async createPool(input: CreatePoolInput): Promise<DbPool> {
    if (this.createDelayMs > 0) await new Promise((r) => setTimeout(r, this.createDelayMs));
    const pool = new FakePool(input);
    if (this.nextPoolPingError) {
      pool.pingError = this.nextPoolPingError;
      this.nextPoolPingError = undefined;
    }
    this.createdPools.push(pool);
    return pool;
  }
  buildExplainSql(q: string): string {
    return `EXPLAIN ${q}`;
  }
  serverInfoSql(): string {
    return 'SELECT 1';
  }
  classifyError(): ErrorClass {
    return 'unknown';
  }
  isTimeoutError(): boolean {
    return false;
  }
  defaultPort(): number {
    return 5432;
  }
  extractEndpoint(options: Record<string, unknown>): Endpoint {
    return { host: options['host'] as string, port: options['port'] as number };
  }
}

class MutableEnvProvider implements SecretProvider {
  readonly name = 'env';
  values: Record<string, unknown> = {};
  async resolve(): Promise<ResolvedSecret> {
    return { data: { ...this.values } };
  }
}

function setup(withSecrets = false) {
  const configService = new ConfigService(
    parseConfig({
      connections: {
        db1: {
          type: 'postgres',
          options: withSecrets
            ? { host: 'h', port: 5432, database: 'd', password: '${env.password}' }
            : { host: 'h', port: 5432, database: 'd' },
          ...(withSecrets ? { secrets: { env: { password: 'X' } } } : {}),
        },
      },
    }),
  );
  const provider = new MutableEnvProvider();
  provider.values = { password: 'pw1' };
  const logger = new StderrLogger('silent');
  const secretsManager = new SecretsManager(configService, new SecretProviderRegistry([provider]), logger);
  const driver = new FakeDriver();
  const manager = new PoolManager(configService, new DialectRegistry([driver]), secretsManager, logger);
  return { manager, driver, secretsManager, provider };
}

describe('PoolManager', () => {
  it('creates a pool once and caches it', async () => {
    const { manager, driver } = setup();
    const a = await manager.acquire('db1');
    const b = await manager.acquire('db1');
    expect(a).toBe(b);
    expect(driver.createdPools).toHaveLength(1);
  });

  it('deduplicates concurrent acquires (single-flight)', async () => {
    const { manager, driver } = setup();
    driver.createDelayMs = 20;
    const [a, b, c] = await Promise.all([manager.acquire('db1'), manager.acquire('db1'), manager.acquire('db1')]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(driver.createdPools).toHaveLength(1);
  });

  it('close() ends the pool and recreate() builds a new one', async () => {
    const { manager, driver } = setup();
    const first = (await manager.acquire('db1')) as FakePool;
    await manager.close('db1');
    expect(first.ended).toBe(true);
    const second = await manager.acquire('db1');
    expect(second).not.toBe(first);
    expect(driver.createdPools).toHaveLength(2);
  });

  it('swaps the pool on credential rotation and drains the old one', async () => {
    const { manager, driver, secretsManager, provider } = setup(true);
    const first = (await manager.acquire('db1')) as FakePool;
    expect(first.input.renderedOptions['password']).toBe('pw1');

    provider.values = { password: 'pw2' };
    await secretsManager.forceResolve('db1');
    secretsManager.emit('rotated', 'db1');
    await vi.waitFor(() => {
      expect(driver.createdPools).toHaveLength(2);
      expect(first.ended).toBe(true);
    });

    const second = (await manager.acquire('db1')) as FakePool;
    expect(second.input.renderedOptions['password']).toBe('pw2');
    expect(second.pinged).toBe(1);
    secretsManager.dispose();
  });

  it('drains the freshly built pool when the rotation swap fails (no leak)', async () => {
    const { manager, driver, secretsManager, provider } = setup(true);
    const first = (await manager.acquire('db1')) as FakePool;

    provider.values = { password: 'pw2' };
    await secretsManager.forceResolve('db1');
    driver.nextPoolPingError = new Error('ping failed after rotation');
    secretsManager.emit('rotated', 'db1');

    await vi.waitFor(() => {
      expect(driver.createdPools).toHaveLength(2);
      expect(driver.createdPools[1]!.ended).toBe(true); // the new pool was closed, not leaked
    });
    // The swap failed, so the original pool stays live and cached.
    expect(first.ended).toBe(false);
    expect(await manager.acquire('db1')).toBe(first);
    secretsManager.dispose();
  });

  it('ignores rotation events when fingerprints match', async () => {
    const { manager, driver, secretsManager } = setup(true);
    await manager.acquire('db1');
    secretsManager.emit('rotated', 'db1');
    await new Promise((r) => setTimeout(r, 20));
    expect(driver.createdPools).toHaveLength(1);
    secretsManager.dispose();
  });

  it('multi-database connection: one pool per database, one shared tunnel ref', async () => {
    const configService = new ConfigService(
      parseConfig({
        tunnels: { t1: { type: 'ssm', options: { target: 'i-1' } } },
        connections: {
          db1: { type: 'postgres', options: { host: 'h', port: 5432, databases: ['a', 'b'] }, tunnel: { target: 't1' } },
        },
      }),
    );
    const logger = new StderrLogger('silent');
    const secretsManager = new SecretsManager(configService, new SecretProviderRegistry([]), logger);
    const driver = new FakeDriver();
    const manager = new PoolManager(configService, new DialectRegistry([driver]), secretsManager, logger);
    const ensured: string[] = [];
    const released: string[] = [];
    manager.setConnectionTunnels({
      ensure: async (key: string) => {
        ensured.push(key);
        return { host: '127.0.0.1', port: 21_000, id: 'tun_x', reused: ensured.length > 1 };
      },
      release: async (key: string) => {
        released.push(key);
      },
      isHealthy: async () => true,
      reopen: async () => ({ host: '127.0.0.1', port: 21_000 }),
    });

    const poolA = (await manager.acquire('db1', 'a')) as FakePool;
    const poolB = (await manager.acquire('db1', 'b')) as FakePool;
    expect(poolA).not.toBe(poolB);
    expect(poolA.input.renderedOptions['database']).toBe('a');
    expect(poolB.input.renderedOptions['database']).toBe('b');
    expect(poolA.input.renderedOptions['databases']).toBeUndefined(); // never reaches the driver
    expect(driver.createdPools).toHaveLength(2);

    // Closing one pool keeps the tunnel; closing the last releases it.
    await manager.close('db1', { database: 'a' });
    expect(released).toEqual([]);
    await manager.close('db1', { database: 'b' });
    expect(released).toEqual(['db1']);
  });

  it('credential rotation swaps every pool of the connection', async () => {
    const configService = new ConfigService(
      parseConfig({
        connections: {
          db1: {
            type: 'postgres',
            options: { host: 'h', port: 5432, databases: ['a', 'b'], password: '${env.password}' },
            secrets: { env: { password: 'X' } },
          },
        },
      }),
    );
    const provider = new MutableEnvProvider();
    provider.values = { password: 'pw1' };
    const logger = new StderrLogger('silent');
    const secretsManager = new SecretsManager(configService, new SecretProviderRegistry([provider]), logger);
    const driver = new FakeDriver();
    const manager = new PoolManager(configService, new DialectRegistry([driver]), secretsManager, logger);

    const poolA = (await manager.acquire('db1', 'a')) as FakePool;
    const poolB = (await manager.acquire('db1', 'b')) as FakePool;

    provider.values = { password: 'pw2' };
    await secretsManager.forceResolve('db1');
    secretsManager.emit('rotated', 'db1');
    await vi.waitFor(() => {
      expect(driver.createdPools).toHaveLength(4); // 2 originals + 2 swapped
      expect(poolA.ended).toBe(true);
      expect(poolB.ended).toBe(true);
    });
    const swappedA = (await manager.acquire('db1', 'a')) as FakePool;
    expect(swappedA.input.renderedOptions['password']).toBe('pw2');
    expect(swappedA.input.renderedOptions['database']).toBe('a');
    secretsManager.dispose();
  });

  it('fails with TUNNEL_FAILED when a tunnel is required but not wired', async () => {
    const configService = new ConfigService(
      parseConfig({
        tunnels: { t1: { type: 'ssm', options: { target: 'i-1' } } },
        connections: {
          db1: { type: 'postgres', options: { host: 'h', database: 'd' }, tunnel: { target: 't1' } },
        },
      }),
    );
    const logger = new StderrLogger('silent');
    const secretsManager = new SecretsManager(configService, new SecretProviderRegistry([]), logger);
    const manager = new PoolManager(configService, new DialectRegistry([new FakeDriver()]), secretsManager, logger);
    await expect(manager.acquire('db1')).rejects.toMatchObject({ code: 'TUNNEL_FAILED' });
  });
});
