import { describe, expect, it } from 'vitest';
import { DialectRegistry, SecretProviderRegistry } from '../../src/composition/registries';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import type {
  CreatePoolInput,
  DbPool,
  DialectDriver,
  Endpoint,
  ErrorClass,
} from '../../src/interfaces/dialect-driver';
import type { ConnectionTunnels } from '../../src/interfaces/tunnel-provider';
import { StderrLogger } from '../../src/logging/logger';
import { QueryExecutor } from '../../src/pools/execute';
import { PoolManager } from '../../src/pools/pool-manager';
import { SecretsManager } from '../../src/secrets/secrets-manager';

class ScriptedPool implements DbPool {
  constructor(private readonly script: () => Promise<unknown>) {}
  async query() {
    await this.script();
    return { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 };
  }
  async ping() {}
  async end() {}
}

class ScriptedDriver implements DialectDriver {
  readonly dialect = 'postgres';
  readonly explainFormat = 'json' as const;
  poolsCreated = 0;
  constructor(private readonly script: () => Promise<unknown>) {}
  async createPool(_input: CreatePoolInput): Promise<DbPool> {
    this.poolsCreated += 1;
    return new ScriptedPool(this.script);
  }
  buildExplainSql(q: string) {
    return q;
  }
  serverInfoSql(): string {
    return 'SELECT 1';
  }
  classifyError(err: unknown): ErrorClass {
    return ((err as { klass?: ErrorClass }).klass ?? 'unknown');
  }
  isTimeoutError(err: unknown): boolean {
    return (err as { timeout?: boolean }).timeout === true;
  }
  defaultPort() {
    return 5432;
  }
  extractEndpoint(): Endpoint {
    return { host: 'h', port: 5432 };
  }
}

class FakeTunnels implements ConnectionTunnels {
  healthy = true;
  reopens = 0;
  async ensure() {
    return { host: '127.0.0.1', port: 21_000, id: 'tun_fake0001', reused: false };
  }
  async release() {}
  async isHealthy() {
    return this.healthy;
  }
  async reopen() {
    this.reopens += 1;
    this.healthy = true;
    return { host: '127.0.0.1', port: 21_001 };
  }
}

function setup(script: () => Promise<unknown>, withTunnel = false) {
  const configService = new ConfigService(
    parseConfig({
      ...(withTunnel ? { tunnels: { t1: { type: 'ssm', options: { target: 'i-1' } } } } : {}),
      connections: {
        db1: {
          type: 'postgres',
          options: { host: 'h', port: 5432, database: 'd' },
          ...(withTunnel ? { tunnel: { target: 't1' } } : {}),
        },
      },
    }),
  );
  const logger = new StderrLogger('silent');
  const driver = new ScriptedDriver(script);
  const dialects = new DialectRegistry([driver]);
  const secretsManager = new SecretsManager(configService, new SecretProviderRegistry([]), logger);
  const poolManager = new PoolManager(configService, dialects, secretsManager, logger);
  const tunnels = new FakeTunnels();
  if (withTunnel) poolManager.setConnectionTunnels(tunnels);
  const executor = new QueryExecutor({
    configService,
    dialects,
    poolManager,
    secretsManager,
    logger,
    ...(withTunnel ? { tunnels } : {}),
    sleep: async () => {}, // no real backoff in tests
  });
  return { executor, driver, tunnels, poolManager };
}

const connErr = () => Object.assign(new Error('connection refused'), { klass: 'connection' });

describe('QueryExecutor retry policy', () => {
  it('retries connection errors up to 3 attempts, then CONNECTION_FAILED', async () => {
    let calls = 0;
    const { executor } = setup(async () => {
      calls += 1;
      throw connErr();
    });
    await expect(executor.execute('db1', (pool) => pool.query('SELECT 1', { maxRows: 1, timeoutMs: 1 }))).rejects.toMatchObject(
      { code: 'CONNECTION_FAILED' },
    );
    expect(calls).toBe(3);
  });

  it('succeeds when a retry works', async () => {
    let calls = 0;
    const { executor } = setup(async () => {
      calls += 1;
      if (calls < 3) throw connErr();
      return undefined;
    });
    const result = await executor.execute('db1', (pool) => pool.query('SELECT 1', { maxRows: 1, timeoutMs: 1 }));
    expect(result.rowCount).toBe(0);
    expect(calls).toBe(3);
  });

  it('never retries auth errors', async () => {
    let calls = 0;
    const { executor } = setup(async () => {
      calls += 1;
      throw Object.assign(new Error('password authentication failed'), { klass: 'auth' });
    });
    await expect(executor.execute('db1', (pool) => pool.query('SELECT 1', { maxRows: 1, timeoutMs: 1 }))).rejects.toMatchObject(
      { code: 'CONNECTION_FAILED', hint: expect.stringContaining('not retried') },
    );
    expect(calls).toBe(1);
  });

  it('never retries plain query errors', async () => {
    let calls = 0;
    const { executor } = setup(async () => {
      calls += 1;
      throw Object.assign(new Error('syntax error'), { klass: 'query' });
    });
    await expect(executor.execute('db1', (pool) => pool.query('SELECT 1', { maxRows: 1, timeoutMs: 1 }))).rejects.toMatchObject(
      { code: 'QUERY_FAILED' },
    );
    expect(calls).toBe(1);
  });

  it('maps driver timeouts to QUERY_TIMEOUT', async () => {
    const { executor } = setup(async () => {
      throw Object.assign(new Error('canceled'), { timeout: true });
    });
    await expect(executor.execute('db1', (pool) => pool.query('SELECT 1', { maxRows: 1, timeoutMs: 1 }))).rejects.toMatchObject(
      { code: 'QUERY_TIMEOUT' },
    );
  });

  it('reopens an unhealthy tunnel between retries', async () => {
    let calls = 0;
    const { executor, tunnels, driver } = setup(async () => {
      calls += 1;
      if (calls === 1) {
        tunnels.healthy = false;
        throw connErr();
      }
      return undefined;
    }, true);
    await executor.execute('db1', (pool) => pool.query('SELECT 1', { maxRows: 1, timeoutMs: 1 }));
    expect(tunnels.reopens).toBe(1);
    expect(driver.poolsCreated).toBe(2); // original + recreate after reopen
  });
});
