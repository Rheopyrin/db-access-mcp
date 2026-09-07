import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DialectRegistry, SecretProviderRegistry, TunnelProviderRegistry } from '../../src/composition/registries';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { loadMergedConfig } from '../../src/config/loader';
import { diffConfigs } from '../../src/config/reload';
import type { CreatePoolInput, DbPool, DialectDriver, Endpoint, ErrorClass } from '../../src/interfaces/dialect-driver';
import type { ResolvedSecret, SecretProvider } from '../../src/interfaces/secret-provider';
import type { TunnelHandle, TunnelOpenRequest, TunnelProvider } from '../../src/interfaces/tunnel-provider';
import { StderrLogger } from '../../src/logging/logger';
import { PoolManager } from '../../src/pools/pool-manager';
import { SecretsManager } from '../../src/secrets/secrets-manager';
import { ConfigReloadTool } from '../../src/server/tools/config-reload.tool';
import { TunnelManager } from '../../src/tunnels/tunnel-manager';

class FakePool implements DbPool {
  ended = false;
  constructor(readonly input: CreatePoolInput) {}
  async query() {
    return { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 };
  }
  async ping() {
    /* always healthy */
  }
  async end() {
    this.ended = true;
  }
}

class FakeDriver implements DialectDriver {
  readonly dialect = 'postgres';
  readonly explainFormat = 'json' as const;
  createdPools: FakePool[] = [];

  async createPool(input: CreatePoolInput): Promise<DbPool> {
    const pool = new FakePool(input);
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

class FakeHandle implements TunnelHandle {
  readonly localHost = '127.0.0.1';
  readonly externalPids = [4242];
  closed = false;
  constructor(readonly localPort: number) {}
  async isHealthy() {
    return !this.closed;
  }
  async close() {
    this.closed = true;
  }
}

class FakeTunnelProvider implements TunnelProvider {
  readonly type = 'ssm';
  opened: FakeHandle[] = [];
  async open(req: TunnelOpenRequest): Promise<TunnelHandle> {
    const handle = new FakeHandle(req.localPort);
    this.opened.push(handle);
    return handle;
  }
}

class CountingEnvProvider implements SecretProvider {
  readonly name = 'env';
  resolves = 0;
  async resolve(): Promise<ResolvedSecret> {
    this.resolves += 1;
    return { data: { password: 'pw' } };
  }
}

const TUNNEL = { type: 'ssm', options: { target: 'i-1', region: 'r' } };

function connection(host: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'postgres', options: { host, port: 5432, database: 'd' }, ...extra };
}

function writeConfig(workdir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(workdir, 'config.json'), JSON.stringify(config));
}

function setup(initial: Record<string, unknown>) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-reload-'));
  writeConfig(workdir, initial);
  const { config, files } = loadMergedConfig(workdir);
  const configService = new ConfigService(config, { workdir, envFileArgs: [], files });

  const logger = new StderrLogger('silent');
  const dialects = new DialectRegistry([new FakeDriver()]);
  const secretProvider = new CountingEnvProvider();
  const secretsManager = new SecretsManager(configService, new SecretProviderRegistry([secretProvider]), logger);
  const poolManager = new PoolManager(configService, dialects, secretsManager, logger);
  const tunnelProvider = new FakeTunnelProvider();
  const tunnelManager = new TunnelManager(configService, new TunnelProviderRegistry([tunnelProvider]), logger);
  poolManager.setConnectionTunnels(tunnelManager);

  const tool = new ConfigReloadTool(configService, dialects, poolManager, secretsManager, tunnelManager, logger);
  return { workdir, configService, secretsManager, secretProvider, poolManager, tunnelManager, tool };
}

interface ReloadPayload {
  reloaded?: boolean;
  code?: string;
  message?: string;
  files?: string[];
  connections?: { added: string[]; removed: string[]; changed: string[]; unchanged: number };
  tunnels?: { added: string[]; removed: string[]; changed: string[]; unchanged: number };
  warnings?: string[];
  pool_defaults_changed?: boolean;
}

async function reload(tool: ConfigReloadTool): Promise<{ result: ReloadPayload; isError: boolean }> {
  const result = await tool.execute();
  return { result: result.structuredContent as ReloadPayload, isError: result.isError === true };
}

describe('diffConfigs', () => {
  it('classifies added, removed, changed and unchanged entries', () => {
    const previous = parseConfig({
      tunnels: { t1: TUNNEL },
      connections: { a: connection('a'), b: connection('b'), c: connection('c') },
    });
    const next = parseConfig({
      tunnels: { t1: TUNNEL, t2: TUNNEL },
      connections: { a: connection('a'), b: connection('b-changed'), d: connection('d') },
    });
    const diff = diffConfigs(previous, next);
    expect(diff.connections).toEqual({ added: ['d'], removed: ['c'], changed: ['b'], unchanged: ['a'] });
    expect(diff.tunnels).toEqual({ added: ['t2'], removed: [], changed: [], unchanged: ['t1'] });
  });

  it('ignores key order inside a definition', () => {
    const previous = parseConfig({ connections: { a: { type: 'postgres', options: { host: 'h', database: 'd' } } } });
    const next = parseConfig({ connections: { a: { options: { database: 'd', host: 'h' }, type: 'postgres' } } });
    expect(diffConfigs(previous, next).connections.unchanged).toEqual(['a']);
  });

  it('marks a connection changed when only the global pool defaults changed', () => {
    const previous = parseConfig({ connections: { a: connection('a') } });
    const next = parseConfig({ pool: { max: 9 }, connections: { a: connection('a') } });
    const diff = diffConfigs(previous, next);
    expect(diff.connections.changed).toEqual(['a']);
    expect(diff.poolDefaultsChanged).toBe(true);
  });
});

describe('config_reload', () => {
  it('picks up connections and tunnels added to the file, and reports the diff', async () => {
    const { workdir, configService, tool } = setup({ connections: { a: connection('a'), old: connection('old') } });

    writeConfig(workdir, {
      tunnels: { t1: TUNNEL },
      connections: { a: connection('a'), b: connection('b', { tunnel: { target: 't1' } }) },
    });
    const { result, isError } = await reload(tool);

    expect(isError).toBe(false);
    expect(result.reloaded).toBe(true);
    expect(result.connections).toEqual({ added: ['b'], removed: ['old'], changed: [], unchanged: 1 });
    expect(result.tunnels).toEqual({ added: ['t1'], removed: [], changed: [], unchanged: 0 });
    expect(result.files).toEqual([path.join(workdir, 'config.json')]);
    expect(result.warnings).toEqual([]);

    // The swap is visible to every consumer reading through the service.
    expect(configService.connectionKeys().sort()).toEqual(['a', 'b']);
    expect(configService.getConnection('b').tunnel?.target).toBe('t1');
    expect(configService.findConnection('old')).toBeUndefined();
  });

  it('keeps the previous config and reports the error when the new file is invalid', async () => {
    const { workdir, configService, tool } = setup({ connections: { a: connection('a') } });

    fs.writeFileSync(path.join(workdir, 'config.json'), '{ this is not json');
    const broken = await reload(tool);
    expect(broken.isError).toBe(true);
    expect(broken.result.code).toBe('CONFIG_INVALID');
    expect(broken.result.message).toMatch(/not valid JSON/);
    expect(configService.connectionKeys()).toEqual(['a']);

    // Schema violation: unknown key.
    writeConfig(workdir, { connections: { a: connection('a') }, nonsense: true });
    const unknownKey = await reload(tool);
    expect(unknownKey.isError).toBe(true);
    expect(unknownKey.result.code).toBe('CONFIG_INVALID');

    // Semantic violation: connection referencing an undefined tunnel.
    writeConfig(workdir, { connections: { a: connection('a', { tunnel: { target: 'nope' } }) } });
    const badTunnel = await reload(tool);
    expect(badTunnel.isError).toBe(true);
    expect(badTunnel.result.message).toMatch(/tunnel target "nope"/);

    // Unknown dialect: rejected here rather than on the first query.
    writeConfig(workdir, { connections: { a: { type: 'oracle', options: { host: 'h', database: 'd' } } } });
    const badDialect = await reload(tool);
    expect(badDialect.isError).toBe(true);
    expect(badDialect.result.message).toMatch(/unknown type "oracle"/);

    // Through all of it the server kept serving the original configuration.
    expect(configService.connectionKeys()).toEqual(['a']);
    expect(configService.getConnection('a').options['host']).toBe('a');
  });

  it('leaves live pools and tunnels untouched and warns about them', async () => {
    const { workdir, poolManager, tunnelManager, tool } = setup({
      tunnels: { t1: TUNNEL },
      connections: {
        live: connection('live', { tunnel: { target: 't1' } }),
        idle: connection('idle'),
      },
    });

    const pool = (await poolManager.acquire('live')) as FakePool;
    await tunnelManager.ensure('live', { host: 'live', port: 5432 }, { pin: true });
    const handle = tunnelManager.liveTunnels();
    expect(handle).toHaveLength(1);

    // "live" is edited, "t1" is edited, "idle" disappears.
    writeConfig(workdir, {
      tunnels: { t1: { type: 'ssm', options: { target: 'i-2', region: 'r' } } },
      connections: { live: connection('live-moved', { tunnel: { target: 't1' } }) },
    });
    const { result, isError } = await reload(tool);
    expect(isError).toBe(false);
    expect(result.connections?.changed).toEqual(['live']);
    expect(result.connections?.removed).toEqual(['idle']);
    expect(result.tunnels?.changed).toEqual(['t1']);

    // Nothing was closed or rebuilt.
    expect(pool.ended).toBe(false);
    expect(await poolManager.acquire('live')).toBe(pool);
    expect(pool.input.renderedOptions['host']).toBe('live');
    const stillOpen = tunnelManager.liveTunnels();
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]?.id).toBe(handle[0]?.id);
    expect(await tunnelManager.isHealthy('live')).toBe(true);

    // ...and the caller is told why.
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings?.some((w) => w.includes('connection "live"') && w.includes('open pool'))).toBe(true);
    expect(result.warnings?.some((w) => w.includes('tunnel "t1"') && w.includes('currently open'))).toBe(true);
  });

  it('drops cached secrets of changed connections without pools, but keeps them for live ones', async () => {
    const withSecret = (host: string) => ({
      type: 'postgres',
      options: { host, port: 5432, database: 'd', password: '${env.password}' },
      secrets: { env: { password: 'PW_VAR' } },
    });
    const { workdir, secretsManager, secretProvider, poolManager, tool } = setup({
      connections: { live: withSecret('live'), idle: withSecret('idle') },
    });

    await poolManager.acquire('live');
    await secretsManager.getRenderedOptions('idle');
    expect(secretProvider.resolves).toBe(2);

    writeConfig(workdir, { connections: { live: withSecret('live2'), idle: withSecret('idle2') } });
    const { result } = await reload(tool);
    expect(result.connections?.changed).toEqual(['idle', 'live']);

    // "idle" has no pool: its cache was dropped and the next use re-resolves.
    await secretsManager.getRenderedOptions('idle');
    expect(secretProvider.resolves).toBe(3);
    // "live" has an open pool: its cache entry (and its refresh timer) survives.
    await secretsManager.getRenderedOptions('live');
    expect(secretProvider.resolves).toBe(3);

    secretsManager.dispose();
  });

  it('refuses to reload when the server was started from an in-memory config', async () => {
    const configService = new ConfigService(parseConfig({ connections: { a: connection('a') } }));
    const logger = new StderrLogger('silent');
    const dialects = new DialectRegistry([new FakeDriver()]);
    const secretsManager = new SecretsManager(configService, new SecretProviderRegistry([]), logger);
    const poolManager = new PoolManager(configService, dialects, secretsManager, logger);
    const tunnelManager = new TunnelManager(configService, new TunnelProviderRegistry([]), logger);
    const tool = new ConfigReloadTool(configService, dialects, poolManager, secretsManager, tunnelManager, logger);

    const { result, isError } = await reload(tool);
    expect(isError).toBe(true);
    expect(result.message).toMatch(/not started from configuration files/);
  });
});
