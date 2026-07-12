import { describe, expect, it } from 'vitest';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { StderrLogger } from '../../src/logging/logger';
import { VaultClientManager, type VaultClient } from '../../src/secrets/vault-clients';
import { VaultSecretProvider } from '../../src/secrets/vault.provider';

const logger = new StderrLogger('silent');
const emptyConfig = new ConfigService(parseConfig({}));

type Read = (path: string) => Promise<Record<string, unknown>>;
type Write = (path: string, data?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function clientOf(read: Read, write?: Write): VaultClient {
  return { read: read, write: (write ?? (async () => ({}))) };
}

function providerWith(read: Read, write?: Write) {
  const manager = new VaultClientManager(emptyConfig, () => clientOf(read, write));
  return new VaultSecretProvider(manager, logger);
}

describe('VaultSecretProvider', () => {
  it('unwraps KV v2 responses and treats them as static (no lease)', async () => {
    const provider = providerWith(async () => ({
      data: { data: { user: 'alice', password: 'pw' }, metadata: { version: 3 } },
      lease_id: '',
      lease_duration: 0,
    }));
    const secret = await provider.resolve({ path: 'secret/data/db' }, 'db1');
    expect(secret.data).toEqual({ user: 'alice', password: 'pw' });
    expect(secret.ttlMs).toBeUndefined();
    expect(secret.leaseId).toBeUndefined();
  });

  it('maps dynamic secrets with lease_id and lease_duration', async () => {
    const provider = providerWith(async () => ({
      data: { username: 'v-user', password: 'v-pass' },
      lease_id: 'database/creds/app/abc',
      lease_duration: 3600,
    }));
    const secret = await provider.resolve({ path: 'database/creds/app' }, 'db1');
    expect(secret.data).toEqual({ username: 'v-user', password: 'v-pass' });
    expect(secret.ttlMs).toBe(3_600_000);
    expect(secret.leaseId).toBe('database/creds/app/abc');
  });

  it('renews a lease keeping the data', async () => {
    let renewedLease: string | undefined;
    const provider = providerWith(
      async () => ({ data: {}, lease_duration: 0 }),
      async (_path, data) => {
        renewedLease = data?.['lease_id'] as string;
        return { lease_duration: 1800 };
      },
    );
    const renewed = await provider.renew(
      { data: { password: 'pw' }, ttlMs: 3_600_000, leaseId: 'lease-1' },
      { path: 'database/creds/app' },
      'db1',
    );
    expect(renewedLease).toBe('lease-1');
    expect(renewed.ttlMs).toBe(1_800_000);
    expect(renewed.data).toEqual({ password: 'pw' });
  });

  it('wraps read failures into SECRET_RESOLUTION_FAILED', async () => {
    const provider = providerWith(async () => {
      throw new Error('permission denied');
    });
    await expect(provider.resolve({ path: 'secret/data/db' }, 'db1')).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
      message: expect.stringContaining('permission denied'),
    });
  });

  it('rejects an invalid spec', async () => {
    const provider = providerWith(async () => ({}));
    await expect(provider.resolve({ nope: 1 }, 'db1')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('VaultClientManager', () => {
  it('routes targets to distinct cached clients and no-target to the default client', async () => {
    const created: (string | undefined)[] = [];
    const manager = new VaultClientManager(emptyConfig, (target) => {
      created.push(target);
      return clientOf(async () => ({ data: { from: target ?? 'default' } }));
    });
    const a = manager.getClient('vault-a', 'db1');
    const b = manager.getClient('vault-b', 'db1');
    const aAgain = manager.getClient('vault-a', 'db2');
    const dflt = manager.getClient(undefined, 'db3');
    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
    expect(dflt).not.toBe(a);
    expect(created).toEqual(['vault-a', 'vault-b', undefined]);
    expect((await dflt.read('x'))['data']).toEqual({ from: 'default' });
  });

  it('a user-defined entry named "default" is separate from the implicit default client', () => {
    const manager = new VaultClientManager(emptyConfig, (target) =>
      clientOf(async () => ({ data: { target: target ?? 'implicit' } })),
    );
    const userDefault = manager.getClient('default', 'db1');
    const implicit = manager.getClient(undefined, 'db1');
    expect(userDefault).not.toBe(implicit);
  });

  it('without VAULT_ADDR the implicit default client fails with a clear error', () => {
    const saved = process.env['VAULT_ADDR'];
    delete process.env['VAULT_ADDR'];
    try {
      const manager = new VaultClientManager(emptyConfig);
      expect(() => manager.getClient(undefined, 'db1')).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('VAULT_ADDR') }),
      );
    } finally {
      if (saved !== undefined) process.env['VAULT_ADDR'] = saved;
    }
  });

  it('resolves env-ref address/token for named entries', () => {
    process.env['VC_TEST_ADDR'] = 'https://envvault:8200';
    process.env['VC_TEST_TOKEN'] = 'tok';
    try {
      const config = new ConfigService(
        parseConfig({ vault: { dr: { address: { env: 'VC_TEST_ADDR' }, token: { env: 'VC_TEST_TOKEN' } } } }),
      );
      const manager = new VaultClientManager(config);
      expect(() => manager.getClient('dr', 'db1')).not.toThrow();
    } finally {
      delete process.env['VC_TEST_ADDR'];
      delete process.env['VC_TEST_TOKEN'];
    }
  });

  it('fails when a named entry references a missing env var', () => {
    const config = new ConfigService(parseConfig({ vault: { dr: { address: { env: 'VC_MISSING_ADDR' } } } }));
    const manager = new VaultClientManager(config);
    expect(() => manager.getClient('dr', 'db1')).toThrow(/VC_MISSING_ADDR/);
  });

  it('fails when a named entry has no address at all', () => {
    const config = new ConfigService(parseConfig({ vault: { bare: { token: 't' } } }));
    const manager = new VaultClientManager(config);
    expect(() => manager.getClient('bare', 'db1')).toThrow(/no address/);
  });
});
