import { describe, expect, it } from 'vitest';
import { TunnelProviderRegistry } from '../../src/composition/registries';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import type { TunnelHandle, TunnelOpenRequest, TunnelProvider } from '../../src/interfaces/tunnel-provider';
import { StderrLogger } from '../../src/logging/logger';
import { TunnelManager, type TunnelRegistrar } from '../../src/tunnels/tunnel-manager';

class FakeHandle implements TunnelHandle {
  readonly localHost = '127.0.0.1';
  readonly externalPids = [1111];
  healthy = true;
  closed = false;
  constructor(readonly localPort: number) {}
  async isHealthy() {
    return this.healthy && !this.closed;
  }
  async close() {
    this.closed = true;
  }
}

class FakeProvider implements TunnelProvider {
  readonly type = 'ssm';
  opened: FakeHandle[] = [];
  requests: TunnelOpenRequest[] = [];
  async open(req: TunnelOpenRequest): Promise<TunnelHandle> {
    this.requests.push(req);
    const handle = new FakeHandle(req.localPort);
    this.opened.push(handle);
    return handle;
  }
}

class RecordingRegistrar implements TunnelRegistrar {
  records: unknown[] = [];
  removals: string[] = [];
  recordTunnel(entry: { cacheKey: string }): void {
    this.records.push(entry);
  }
  removeTunnel(cacheKey: string): void {
    this.removals.push(cacheKey);
  }
}

function setup() {
  const configService = new ConfigService(
    parseConfig({
      tunnels: { t1: { type: 'ssm', options: { target: 'i-1', region: 'r' } } },
      connections: {
        db1: { type: 'postgres', options: { host: 'db.remote', port: 5432, database: 'd' }, tunnel: { target: 't1' } },
        db2: { type: 'postgres', options: { host: 'db.remote', port: 5432, database: 'd' }, tunnel: { target: 't1' } },
        db3: { type: 'postgres', options: { host: 'other.remote', port: 5432, database: 'd' }, tunnel: { target: 't1' } },
      },
    }),
  );
  const provider = new FakeProvider();
  const manager = new TunnelManager(configService, new TunnelProviderRegistry([provider]), new StderrLogger('silent'));
  const registrar = new RecordingRegistrar();
  manager.setRegistrar(registrar);
  return { manager, provider, registrar };
}

const REMOTE = { host: 'db.remote', port: 5432 };

describe('TunnelManager', () => {
  it('opens one tunnel and reuses it for the same remote endpoint', async () => {
    const { manager, provider } = setup();
    const a = await manager.ensure('db1', REMOTE);
    const b = await manager.ensure('db2', REMOTE);
    expect(provider.opened).toHaveLength(1);
    expect({ host: b.host, port: b.port, id: b.id }).toEqual({ host: a.host, port: a.port, id: a.id });
    expect(b.reused).toBe(true);
  });

  it('opens separate tunnels for different remote endpoints', async () => {
    const { manager, provider } = setup();
    await manager.ensure('db1', REMOTE);
    await manager.ensure('db3', { host: 'other.remote', port: 5432 });
    expect(provider.opened).toHaveLength(2);
  });

  it('closes the tunnel only when the last reference is released', async () => {
    const { manager, provider, registrar } = setup();
    await manager.ensure('db1', REMOTE);
    await manager.ensure('db2', REMOTE);
    await manager.release('db1');
    expect(provider.opened[0]?.closed).toBe(false);
    await manager.release('db2');
    expect(provider.opened[0]?.closed).toBe(true);
    expect(registrar.removals).toHaveLength(1);
  });

  it('reopens an unhealthy cached tunnel on ensure', async () => {
    const { manager, provider } = setup();
    await manager.ensure('db1', REMOTE);
    provider.opened[0]!.healthy = false;
    await manager.ensure('db2', REMOTE);
    expect(provider.opened).toHaveLength(2);
    expect(provider.opened[0]?.closed).toBe(true);
  });

  it('reopen() keeps references and records new pids', async () => {
    const { manager, provider, registrar } = setup();
    await manager.ensure('db1', REMOTE);
    await manager.ensure('db2', REMOTE);
    const endpoint = await manager.reopen('db1');
    expect(provider.opened).toHaveLength(2);
    expect(endpoint.port).toBe(provider.opened[1]?.localPort);
    expect(registrar.records).toHaveLength(2); // initial open + reopen (ensure(db2) reused)
    // db2 still resolves to the reopened tunnel
    expect(await manager.isHealthy('db2')).toBe(true);
    await manager.release('db1');
    await manager.release('db2');
    expect(provider.opened[1]?.closed).toBe(true);
  });

  it('isHealthy() is false for connections without an active tunnel', async () => {
    const { manager } = setup();
    expect(await manager.isHealthy('db1')).toBe(false);
  });

  it('records tunnel pids in the registrar on open', async () => {
    const { manager, registrar } = setup();
    await manager.ensure('db1', REMOTE);
    expect(registrar.records[0]).toMatchObject({ tunnelName: 't1', tunnelType: 'ssm', pids: [1111] });
  });

  describe('requestedLocalPort', () => {
    it('opens the tunnel on the exact requested port', async () => {
      const { manager, provider } = setup();
      const endpoint = await manager.ensure('db1', REMOTE, { requestedLocalPort: 23_456 });
      expect(endpoint.port).toBe(23_456);
      expect(provider.requests[0]?.localPort).toBe(23_456);
    });

    it('reuses a healthy tunnel when the requested port matches', async () => {
      const { manager, provider } = setup();
      const first = await manager.ensure('db1', REMOTE, { requestedLocalPort: 23_457 });
      const second = await manager.ensure('db2', REMOTE, { requestedLocalPort: 23_457 });
      expect(second.port).toBe(first.port);
      expect(second.id).toBe(first.id);
      expect(second.reused).toBe(true);
      expect(provider.opened).toHaveLength(1);
    });

    it('fails when a healthy tunnel is open on a different port and does not disturb it', async () => {
      const { manager, provider } = setup();
      const existing = await manager.ensure('db1', REMOTE);
      await expect(manager.ensure('db2', REMOTE, { requestedLocalPort: 23_458 })).rejects.toMatchObject({
        code: 'TUNNEL_FAILED',
        message: expect.stringContaining(String(existing.port)),
        hint: expect.stringContaining(`127.0.0.1:${existing.port}`),
      });
      expect(provider.opened).toHaveLength(1);
      expect(provider.opened[0]?.closed).toBe(false);
      expect(await manager.isHealthy('db1')).toBe(true);
    });

    it('reopen() keeps the requested port', async () => {
      const { manager, provider } = setup();
      await manager.ensure('db1', REMOTE, { requestedLocalPort: 23_459 });
      const endpoint = await manager.reopen('db1');
      expect(endpoint.port).toBe(23_459);
      expect(provider.requests[1]?.localPort).toBe(23_459);
    });

    it('without requestedLocalPort behavior is unchanged (random port range)', async () => {
      const { manager } = setup();
      const endpoint = await manager.ensure('db1', REMOTE);
      expect(endpoint.port).toBeGreaterThanOrEqual(20_000);
      expect(endpoint.port).toBeLessThanOrEqual(45_000);
    });
  });

  describe('tunnel ids and pins', () => {
    it('assigns a stable id: same on reuse, preserved across reopen', async () => {
      const { manager } = setup();
      const first = await manager.ensure('db1', REMOTE);
      expect(first.id).toMatch(/^tun_[0-9a-f]{8}$/);
      expect(first.reused).toBe(false);

      const second = await manager.ensure('db2', REMOTE);
      expect(second.id).toBe(first.id);
      expect(second.reused).toBe(true);

      await manager.reopen('db1');
      expect(manager.findById(first.id)).toBeDefined();
    });

    it('a pin keeps the tunnel alive after the pool ref is released, and vice versa', async () => {
      const { manager, provider } = setup();
      await manager.ensure('db1', REMOTE); // pool ref
      const pinned = await manager.ensure('db1', REMOTE, { pin: true }); // up_tunnel pin
      await manager.release('db1'); // pool goes away
      expect(provider.opened[0]?.closed).toBe(false); // pin still holds it

      const result = await manager.releasePins(pinned.id);
      expect(result.closed).toBe(true);
      expect(provider.opened[0]?.closed).toBe(true);
    });

    it('releasePins keeps the tunnel open while pools hold it and reports holders', async () => {
      const { manager, provider } = setup();
      const pinned = await manager.ensure('db1', REMOTE, { pin: true });
      await manager.ensure('db2', REMOTE); // pool ref

      const result = await manager.releasePins(pinned.id);
      expect(result.closed).toBe(false);
      expect(result.holders).toEqual(['db2']);
      expect(provider.opened[0]?.closed).toBe(false);
      expect(await manager.isHealthy('db2')).toBe(true);
    });

    it('forceClose closes despite holders and clears all mappings', async () => {
      const { manager, provider } = setup();
      const pinned = await manager.ensure('db1', REMOTE, { pin: true });
      await manager.ensure('db2', REMOTE);

      expect(manager.poolHolders(pinned.id)).toEqual(['db2']);
      const { holders } = await manager.forceClose(pinned.id);
      expect(holders).toEqual(['db2']);
      expect(provider.opened[0]?.closed).toBe(true);
      expect(manager.findById(pinned.id)).toBeUndefined();
      expect(await manager.isHealthy('db2')).toBe(false);
    });

    it('listActive() reports tunnels with holders, pins, health and stable ids', async () => {
      const { manager, provider } = setup();
      expect(await manager.listActive()).toEqual([]);

      const ensured = await manager.ensure('db1', REMOTE); // pool ref
      await manager.ensure('db2', REMOTE, { pin: true }); // up_tunnel pin
      let list = await manager.listActive();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: ensured.id,
        tunnelName: 't1',
        tunnelType: 'ssm',
        localHost: '127.0.0.1',
        localPort: ensured.port,
        remote: REMOTE,
        healthy: true,
        connections: ['db1'],
        pins: ['db2'],
        externalPids: [1111],
      });

      // Unhealthy tunnels are reported, not closed.
      provider.opened[0]!.healthy = false;
      list = await manager.listActive();
      expect(list[0]?.healthy).toBe(false);
      expect(provider.opened[0]?.closed).toBe(false);

      provider.opened[0]!.healthy = true;
      await manager.release('db1');
      await manager.releasePins(ensured.id);
      expect(await manager.listActive()).toEqual([]);
    });

    it('operations on an unknown id fail with TUNNEL_FAILED and a hint', async () => {
      const { manager } = setup();
      await expect(manager.releasePins('tun_deadbeef')).rejects.toMatchObject({
        code: 'TUNNEL_FAILED',
        hint: expect.stringContaining('up_tunnel'),
      });
      expect(() => manager.poolHolders('tun_deadbeef')).toThrow(/no active tunnel/);
    });
  });
});
