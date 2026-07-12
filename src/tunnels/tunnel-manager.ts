import { randomBytes } from 'node:crypto';
import type { TunnelProviderRegistry } from '../composition/registries';
import type { ConfigService } from '../config/config.service';
import { DbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';
import type { ConnectionTunnels, EnsuredTunnel, TunnelHandle } from '../interfaces/tunnel-provider';
import { pickLocalPort } from './ports';

/** Persists tunnel PIDs for post-mortem cleanup (implemented by InstanceRegistry). */
export interface TunnelRegistrar {
  recordTunnel(entry: {
    cacheKey: string;
    tunnelName: string;
    tunnelType: string;
    localPort: number;
    pids: number[];
  }): void;
  removeTunnel(cacheKey: string): void;
}

interface ActiveTunnel {
  /** Stable public id (tun_xxxxxxxx); survives reopen. */
  id: string;
  cacheKey: string;
  tunnelName: string;
  tunnelType: string;
  remote: { host: string; port: number };
  handle: TunnelHandle;
  /**
   * References holding the tunnel open; closes when the set empties.
   * Pool refs are plain connection keys; up_tunnel pins are "pin:<key>".
   */
  refs: Set<string>;
  explicitLocalPort?: number;
}

const PORT_RACE_RETRIES = 2;
const PIN_PREFIX = 'pin:';

export interface ActiveTunnelInfo {
  id: string;
  tunnelName: string;
  tunnelType: string;
  localHost: string;
  localPort: number;
  remote: { host: string; port: number };
  healthy: boolean;
  /** Pool holders (connection keys). */
  connections: string[];
  /** up_tunnel pins (connection keys, pin: prefix stripped). */
  pins: string[];
  externalPids: number[];
}

function newTunnelId(): string {
  return `tun_${randomBytes(4).toString('hex')}`;
}

/**
 * Per-instance tunnel cache. Tunnels are keyed by (tunnel name, remote
 * host:port) so connections through the same bastion to the same database
 * share one tunnel. Never shared across MCP instances — all state is
 * in-process; the registrar only records PIDs for crash cleanup.
 */
export class TunnelManager implements ConnectionTunnels {
  private readonly active = new Map<string, ActiveTunnel>();
  private readonly connectionToCacheKey = new Map<string, string>();
  private registrar?: TunnelRegistrar;

  constructor(
    private readonly configService: ConfigService,
    private readonly providers: TunnelProviderRegistry,
    private readonly logger: Logger,
  ) {}

  setRegistrar(registrar: TunnelRegistrar): void {
    this.registrar = registrar;
  }

  async ensure(
    connectionKey: string,
    remote: { host: string; port: number },
    opts: { requestedLocalPort?: number; pin?: boolean } = {},
  ): Promise<EnsuredTunnel> {
    const conn = this.configService.getConnection(connectionKey);
    if (!conn.tunnel) {
      throw new DbAccessError('CONFIG_INVALID', `connection "${connectionKey}" has no tunnel configured`);
    }
    const tunnelName = conn.tunnel.target;
    const cacheKey = `${tunnelName}|${remote.host}:${remote.port}`;
    const requested = opts.requestedLocalPort;
    const refKey = opts.pin ? `${PIN_PREFIX}${connectionKey}` : connectionKey;

    const existing = this.active.get(cacheKey);
    if (existing) {
      if (await existing.handle.isHealthy()) {
        if (requested !== undefined && requested !== existing.handle.localPort) {
          // The tunnel may be held by live pools — never disturb it for a port wish.
          throw new DbAccessError(
            'TUNNEL_FAILED',
            `tunnel "${tunnelName}" to ${remote.host}:${remote.port} is already open on local port ${existing.handle.localPort}, not ${requested}`,
            {
              hint:
                `Connect via 127.0.0.1:${existing.handle.localPort}, call up_tunnel without local_port, ` +
                'or wait for the tunnel to close on idle.',
            },
          );
        }
        existing.refs.add(refKey);
        this.connectionToCacheKey.set(refKey, cacheKey);
        return { host: existing.handle.localHost, port: existing.handle.localPort, id: existing.id, reused: true };
      }
      this.logger.warn('cached tunnel unhealthy; reopening', { tunnel: tunnelName, cacheKey });
      await this.closeActive(existing);
    }

    const explicitLocalPort = requested ?? conn.tunnel.localPort;
    const opened = await this.openTunnel(tunnelName, remote, explicitLocalPort);
    const entry: ActiveTunnel = {
      id: newTunnelId(),
      cacheKey,
      tunnelName,
      tunnelType: this.configService.getTunnelConfig(tunnelName).type,
      remote,
      handle: opened,
      refs: new Set([refKey]),
      explicitLocalPort,
    };
    this.active.set(cacheKey, entry);
    this.connectionToCacheKey.set(refKey, cacheKey);
    this.registrar?.recordTunnel({
      cacheKey,
      tunnelName,
      tunnelType: entry.tunnelType,
      localPort: opened.localPort,
      pids: opened.externalPids,
    });
    return { host: opened.localHost, port: opened.localPort, id: entry.id, reused: false };
  }

  /** Snapshot of this instance's open tunnels with a live health probe each. */
  async listActive(): Promise<ActiveTunnelInfo[]> {
    return Promise.all(
      [...this.active.values()].map(async (entry) => ({
        id: entry.id,
        tunnelName: entry.tunnelName,
        tunnelType: entry.tunnelType,
        localHost: entry.handle.localHost,
        localPort: entry.handle.localPort,
        remote: entry.remote,
        // Probe only — an unhealthy tunnel is NOT closed here; the
        // ensure()/retry paths own recovery.
        healthy: await entry.handle.isHealthy(),
        connections: [...entry.refs].filter((ref) => !ref.startsWith(PIN_PREFIX)),
        pins: [...entry.refs].filter((ref) => ref.startsWith(PIN_PREFIX)).map((ref) => ref.slice(PIN_PREFIX.length)),
        externalPids: entry.handle.externalPids,
      })),
    );
  }

  findById(tunnelId: string): { id: string; tunnelName: string; localPort: number } | undefined {
    const entry = this.byId(tunnelId);
    return entry ? { id: entry.id, tunnelName: entry.tunnelName, localPort: entry.handle.localPort } : undefined;
  }

  /**
   * Removes all up_tunnel pins from the tunnel; closes it when nothing else
   * holds it. Pool refs (live connections) are never disturbed.
   */
  async releasePins(tunnelId: string): Promise<{ closed: boolean; holders: string[] }> {
    const entry = this.requireById(tunnelId);
    for (const ref of [...entry.refs]) {
      if (ref.startsWith(PIN_PREFIX)) {
        entry.refs.delete(ref);
        this.connectionToCacheKey.delete(ref);
      }
    }
    if (entry.refs.size === 0) {
      this.logger.info('closing tunnel (pins released, no more references)', { tunnel: entry.tunnelName, id: entry.id });
      await this.closeActive(entry);
      return { closed: true, holders: [] };
    }
    return { closed: false, holders: [...entry.refs] };
  }

  /** Pool connection keys currently holding the tunnel (pins excluded). */
  poolHolders(tunnelId: string): string[] {
    const entry = this.requireById(tunnelId);
    return [...entry.refs].filter((ref) => !ref.startsWith(PIN_PREFIX));
  }

  /** Closes the tunnel unconditionally; returns the pool connections that held it. */
  async forceClose(tunnelId: string): Promise<{ holders: string[] }> {
    const entry = this.requireById(tunnelId);
    const holders = [...entry.refs].filter((ref) => !ref.startsWith(PIN_PREFIX));
    for (const [refKey, cacheKey] of this.connectionToCacheKey) {
      if (cacheKey === entry.cacheKey) this.connectionToCacheKey.delete(refKey);
    }
    this.logger.info('force-closing tunnel', { tunnel: entry.tunnelName, id: entry.id, holders });
    await this.closeActive(entry);
    return { holders };
  }

  private byId(tunnelId: string): ActiveTunnel | undefined {
    for (const entry of this.active.values()) {
      if (entry.id === tunnelId) return entry;
    }
    return undefined;
  }

  private requireById(tunnelId: string): ActiveTunnel {
    const entry = this.byId(tunnelId);
    if (!entry) {
      throw new DbAccessError('TUNNEL_FAILED', `no active tunnel with id "${tunnelId}"`, {
        hint: 'The tunnel may have closed on idle or after a failure. Call up_tunnel to get a fresh id.',
      });
    }
    return entry;
  }

  async release(connectionKey: string): Promise<void> {
    const cacheKey = this.connectionToCacheKey.get(connectionKey);
    if (!cacheKey) return;
    this.connectionToCacheKey.delete(connectionKey);
    const entry = this.active.get(cacheKey);
    if (!entry) return;
    entry.refs.delete(connectionKey);
    if (entry.refs.size === 0) {
      this.logger.info('closing tunnel (no more references)', { tunnel: entry.tunnelName, cacheKey });
      await this.closeActive(entry);
    }
  }

  async isHealthy(connectionKey: string): Promise<boolean> {
    const entry = this.entryFor(connectionKey);
    if (!entry) return false;
    return entry.handle.isHealthy();
  }

  /** Force-reopen (possibly on a new port), keeping existing references. */
  async reopen(connectionKey: string): Promise<{ host: string; port: number }> {
    const entry = this.entryFor(connectionKey);
    if (!entry) {
      const conn = this.configService.getConnection(connectionKey);
      if (!conn.tunnel) {
        throw new DbAccessError('CONFIG_INVALID', `connection "${connectionKey}" has no tunnel configured`);
      }
      throw new DbAccessError('TUNNEL_FAILED', `no active tunnel to reopen for connection "${connectionKey}"`);
    }
    const refs = new Set(entry.refs);
    await this.closeActive(entry);

    const opened = await this.openTunnel(entry.tunnelName, entry.remote, entry.explicitLocalPort);
    const next: ActiveTunnel = { ...entry, handle: opened, refs };
    this.active.set(entry.cacheKey, next);
    for (const ref of refs) this.connectionToCacheKey.set(ref, entry.cacheKey);
    this.registrar?.recordTunnel({
      cacheKey: entry.cacheKey,
      tunnelName: entry.tunnelName,
      tunnelType: entry.tunnelType,
      localPort: opened.localPort,
      pids: opened.externalPids,
    });
    this.logger.info('tunnel reopened', { tunnel: entry.tunnelName, localPort: opened.localPort });
    return { host: opened.localHost, port: opened.localPort };
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.active.values()].map((entry) => this.closeActive(entry)));
    this.connectionToCacheKey.clear();
  }

  private entryFor(connectionKey: string): ActiveTunnel | undefined {
    const cacheKey = this.connectionToCacheKey.get(connectionKey);
    return cacheKey ? this.active.get(cacheKey) : undefined;
  }

  private async openTunnel(
    tunnelName: string,
    remote: { host: string; port: number },
    explicitLocalPort: number | undefined,
  ): Promise<TunnelHandle> {
    const config = this.configService.getTunnelConfig(tunnelName);
    const provider = this.providers.get(config.type);

    let lastError: unknown;
    for (let attempt = 0; attempt <= PORT_RACE_RETRIES; attempt += 1) {
      const localPort = await pickLocalPort(explicitLocalPort);
      try {
        return await provider.open({ name: tunnelName, config, remote, localPort });
      } catch (err) {
        lastError = err;
        // Port race with another process: retry with a fresh random port —
        // unless the port was an explicit config contract.
        const raced = /already in use|EADDRINUSE|address in use/i.test((err as Error).message ?? '');
        if (explicitLocalPort !== undefined || !raced || attempt === PORT_RACE_RETRIES) throw err;
        this.logger.warn('local port raced; retrying with a new port', { tunnel: tunnelName, localPort });
      }
    }
    /* c8 ignore next */
    throw lastError;
  }

  private async closeActive(entry: ActiveTunnel): Promise<void> {
    this.active.delete(entry.cacheKey);
    try {
      await entry.handle.close();
    } catch (err) {
      this.logger.warn('error closing tunnel', { tunnel: entry.tunnelName, err });
    }
    this.registrar?.removeTunnel(entry.cacheKey);
  }
}
