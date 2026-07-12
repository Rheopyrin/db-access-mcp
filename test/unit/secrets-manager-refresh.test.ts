import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretProviderRegistry } from '../../src/composition/registries';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import type { ResolvedSecret, SecretProvider } from '../../src/interfaces/secret-provider';
import { StderrLogger } from '../../src/logging/logger';
import { SecretsManager } from '../../src/secrets/secrets-manager';

class LeasedProvider implements SecretProvider {
  readonly name = 'vault';
  resolveCalls = 0;
  renewCalls = 0;
  password = 'pw1';
  failRenew = false;
  failResolve = false;

  async resolve(): Promise<ResolvedSecret> {
    this.resolveCalls += 1;
    if (this.failResolve) throw new Error('vault down');
    return { data: { password: this.password }, ttlMs: 10_000, leaseId: 'lease-1' };
  }

  async renew(current: ResolvedSecret): Promise<ResolvedSecret> {
    this.renewCalls += 1;
    if (this.failRenew) throw new Error('vault down');
    return { ...current, ttlMs: 10_000 };
  }
}

function setup() {
  const configService = new ConfigService(
    parseConfig({
      connections: {
        db1: {
          type: 'postgres',
          options: { host: 'h', database: 'd', password: '${vault.password}' },
          secrets: { vault: { path: 'database/creds/app' } },
        },
      },
    }),
  );
  const provider = new LeasedProvider();
  const manager = new SecretsManager(configService, new SecretProviderRegistry([provider]), new StderrLogger('silent'));
  return { manager, provider };
}

describe('SecretsManager lease refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules a renew before the lease expires (80% TTL minus jitter)', async () => {
    const { manager, provider } = setup();
    await manager.getRenderedOptions('db1');
    expect(provider.resolveCalls).toBe(1);

    // 80% of 10s = 8s max; jitter subtracts up to 1s. Advance past 8s.
    await vi.advanceTimersByTimeAsync(8_100);
    expect(provider.renewCalls).toBe(1);
    manager.dispose();
  });

  it('emits rotated only when rendered options actually change', async () => {
    const { manager, provider } = setup();
    const rotated: string[] = [];
    manager.on('rotated', (key: string) => rotated.push(key));
    await manager.getRenderedOptions('db1');

    // Renew keeps the same data — no rotation event.
    await vi.advanceTimersByTimeAsync(8_100);
    expect(rotated).toEqual([]);

    // Renew failing (e.g. lease max TTL reached) falls back to resolve, which
    // returns fresh credentials -> rotation event.
    provider.failRenew = true;
    provider.password = 'pw2';
    await vi.advanceTimersByTimeAsync(8_100);
    expect(rotated).toEqual(['db1']);
    expect(provider.resolveCalls).toBe(2);

    const { options } = await manager.getRenderedOptions('db1');
    expect(options['password']).toBe('pw2');
    manager.dispose();
  });

  it('marks the secret stale after the lease deadline passes with failing refreshes', async () => {
    const { manager, provider } = setup();
    await manager.getRenderedOptions('db1');
    provider.failRenew = true;
    provider.failResolve = true; // vault fully unavailable
    // First refresh fails around 7-8s, retries capped by the 10s lease
    // deadline; once past the deadline the entry goes stale.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.isStale('db1')).toBe(true);

    // Next use re-resolves lazily.
    provider.failRenew = false;
    provider.failResolve = false;
    const { options } = await manager.getRenderedOptions('db1');
    expect(options['password']).toBe('pw1');
    expect(manager.isStale('db1')).toBe(false);
    manager.dispose();
  });
});
