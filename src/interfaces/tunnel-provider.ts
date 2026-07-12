import type { TunnelConfig } from '../config/schema';

export interface TunnelHandle {
  readonly localHost: string;
  readonly localPort: number;
  /** External PIDs to record for orphan cleanup ([] for in-process tunnels). */
  readonly externalPids: number[];
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

export interface TunnelOpenRequest {
  /** Tunnel name from the config's "tunnels" section. */
  name: string;
  config: TunnelConfig;
  remote: { host: string; port: number };
  localPort: number;
}

export interface TunnelProvider {
  readonly type: string;
  open(req: TunnelOpenRequest): Promise<TunnelHandle>;
}

export interface EnsuredTunnel {
  host: string;
  port: number;
  /** Stable id of the active tunnel (tun_xxxxxxxx); survives reopen. */
  id: string;
  /** True when an already-open healthy tunnel was reused. */
  reused: boolean;
}

/**
 * Connection-scoped tunnel operations consumed by PoolManager and the retry
 * path. Implemented by TunnelManager; refcounted per MCP instance.
 */
export interface ConnectionTunnels {
  /**
   * Returns the local endpoint, opening (or reusing) the tunnel and taking a
   * ref. `pin: true` takes an up_tunnel pin ref (released by down_tunnel)
   * instead of a pool ref.
   */
  ensure(
    connectionKey: string,
    remote: { host: string; port: number },
    opts?: { requestedLocalPort?: number; pin?: boolean },
  ): Promise<EnsuredTunnel>;
  /** Releases one pool ref; the tunnel closes when the refcount drops to zero. */
  release(connectionKey: string): Promise<void>;
  isHealthy(connectionKey: string): Promise<boolean>;
  /** Force-reopens the tunnel (possibly on a new port), keeping the refcount. */
  reopen(connectionKey: string): Promise<{ host: string; port: number }>;
}
