import { describe, expect, it, vi } from 'vitest';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { StderrLogger } from '../../src/logging/logger';
import { IdleReaper } from '../../src/pools/idle-reaper';
import type { PoolManager } from '../../src/pools/pool-manager';

function makePoolManager(lastUsed: Record<string, number>) {
  const closed: string[] = [];
  const manager = {
    openEntries: () =>
      Object.entries(lastUsed).map(([connectionKey, lastUsedAt]) => ({ connectionKey, database: 'd', lastUsedAt })),
    close: vi.fn(async (key: string) => {
      closed.push(key);
      delete lastUsed[key];
    }),
  } as unknown as PoolManager;
  return { manager, closed };
}

const configService = new ConfigService(
  parseConfig({
    limits: { idle_close_ms: 60_000 },
    connections: {
      short: { type: 'postgres', options: { host: 'h', database: 'd' }, limits: { idle_close_ms: 10_000 } },
      long: { type: 'postgres', options: { host: 'h', database: 'd' } },
    },
  }),
);

describe('IdleReaper', () => {
  it('closes only connections idle past their effective idle_close_ms', async () => {
    const now = 1_000_000;
    const { manager, closed } = makePoolManager({
      short: now - 15_000, // past its 10s limit
      long: now - 15_000, // within the global 60s limit
    });
    const reaper = new IdleReaper(configService, manager, new StderrLogger('silent'));
    await reaper.check(now);
    expect(closed).toEqual(['short']);
  });

  it('closes long-idle connections with the global default', async () => {
    const now = 1_000_000;
    const { manager, closed } = makePoolManager({ long: now - 61_000 });
    const reaper = new IdleReaper(configService, manager, new StderrLogger('silent'));
    await reaper.check(now);
    expect(closed).toEqual(['long']);
  });

  it('keeps recently used connections', async () => {
    const now = 1_000_000;
    const { manager, closed } = makePoolManager({ short: now - 1_000, long: now - 1_000 });
    const reaper = new IdleReaper(configService, manager, new StderrLogger('silent'));
    await reaper.check(now);
    expect(closed).toEqual([]);
  });
});
