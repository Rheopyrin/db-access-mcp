import { EventEmitter } from 'node:events';
import type { ConfigService } from '../config/config.service';
import type { SecretProviderRegistry } from '../composition/registries';
import type { Logger } from '../interfaces/logger';
import type { ResolvedSecret } from '../interfaces/secret-provider';
import { fingerprintOptions, renderOptions } from './renderer';

export interface RenderedConnectionOptions {
  options: Record<string, unknown>;
  fingerprint: string;
}

interface CacheEntry {
  secret: ResolvedSecret;
  renderedOptions: Record<string, unknown>;
  fingerprint: string;
  /** Epoch ms when the lease expires; Infinity for static secrets. */
  expiresAt: number;
  timer?: NodeJS.Timeout;
  stale: boolean;
  refreshFailures: number;
}

const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000] as const;

/**
 * Resolves the connection's secret provider, renders placeholders into options
 * and keeps leased secrets fresh. Emits 'rotated' (connectionKey) when a
 * refresh produced different credentials — PoolManager reacts by swapping pools.
 */
export class SecretsManager extends EventEmitter {
  private readonly cache = new Map<string, CacheEntry>();
  private disposed = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly providers: SecretProviderRegistry,
    private readonly logger: Logger,
  ) {
    super();
  }

  async getRenderedOptions(connectionKey: string): Promise<RenderedConnectionOptions> {
    const conn = this.configService.getConnection(connectionKey);
    const spec = this.configService.secretSpec(connectionKey);
    if (!spec) {
      const options = conn.options;
      return { options, fingerprint: fingerprintOptions(options) };
    }
    let entry = this.cache.get(connectionKey);
    if (!entry || entry.stale) {
      entry = await this.resolveAndRender(connectionKey);
    }
    return { options: entry.renderedOptions, fingerprint: entry.fingerprint };
  }

  isStale(connectionKey: string): boolean {
    const entry = this.cache.get(connectionKey);
    if (!entry) return false;
    // Past-expiry counts as stale even if the refresh timer never fired
    // (laptop sleep): the auth-retry path then force-resolves instead of failing.
    return entry.stale || Date.now() >= entry.expiresAt;
  }

  /** Drops the cache and re-resolves — used by the reconnect/retry path. */
  async forceResolve(connectionKey: string): Promise<RenderedConnectionOptions> {
    const entry = this.cache.get(connectionKey);
    if (entry?.timer) clearTimeout(entry.timer);
    this.cache.delete(connectionKey);
    return this.getRenderedOptions(connectionKey);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.cache.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.cache.clear();
    this.removeAllListeners();
  }

  private async resolveAndRender(connectionKey: string): Promise<CacheEntry> {
    const conn = this.configService.getConnection(connectionKey);
    const spec = this.configService.secretSpec(connectionKey);
    if (!spec) throw new Error(`resolveAndRender called for secretless connection "${connectionKey}"`);

    const provider = this.providers.get(spec.provider);
    const secret = await provider.resolve(spec.spec, connectionKey);
    const entry = this.buildEntry(connectionKey, conn.options, spec.provider, secret);
    this.cache.set(connectionKey, entry);
    this.scheduleRefresh(connectionKey, entry);
    return entry;
  }

  private buildEntry(
    connectionKey: string,
    rawOptions: Record<string, unknown>,
    providerName: string,
    secret: ResolvedSecret,
  ): CacheEntry {
    const renderedOptions = renderOptions(rawOptions, providerName, secret.data, connectionKey);
    const ttlMs = secret.ttlMs && secret.ttlMs > 0 ? secret.ttlMs : undefined;
    return {
      secret,
      renderedOptions,
      fingerprint: fingerprintOptions(renderedOptions),
      expiresAt: ttlMs ? Date.now() + ttlMs : Number.POSITIVE_INFINITY,
      stale: false,
      refreshFailures: 0,
    };
  }

  private scheduleRefresh(connectionKey: string, entry: CacheEntry): void {
    const ttlMs = entry.secret.ttlMs;
    if (!ttlMs || ttlMs <= 0 || this.disposed) return;
    // Refresh at 80% of the lease with up to 10% jitter to avoid thundering herds.
    const jitter = Math.random() * ttlMs * 0.1;
    const delay = Math.max(1_000, ttlMs * 0.8 - jitter);
    entry.timer = setTimeout(() => void this.refresh(connectionKey), delay);
    entry.timer.unref();
  }

  private async refresh(connectionKey: string): Promise<void> {
    if (this.disposed) return;
    const entry = this.cache.get(connectionKey);
    const spec = this.configService.secretSpec(connectionKey);
    if (!entry || !spec) return;

    const conn = this.configService.getConnection(connectionKey);
    const provider = this.providers.get(spec.provider);
    try {
      let secret;
      if (provider.renew && entry.secret.leaseId) {
        try {
          secret = await provider.renew(entry.secret, spec.spec, connectionKey);
        } catch (renewErr) {
          // Renewal fails when the lease hits its max TTL — request fresh
          // credentials instead of giving up.
          this.logger.debug('lease renew failed; re-resolving the secret', { connection: connectionKey, err: renewErr });
          secret = await provider.resolve(spec.spec, connectionKey);
        }
      } else {
        secret = await provider.resolve(spec.spec, connectionKey);
      }
      const next = this.buildEntry(connectionKey, conn.options, spec.provider, secret);
      const rotated = next.fingerprint !== entry.fingerprint;
      this.cache.set(connectionKey, next);
      this.scheduleRefresh(connectionKey, next);
      this.logger.debug('secret refreshed', { connection: connectionKey, rotated });
      if (rotated) this.emit('rotated', connectionKey);
    } catch (err) {
      entry.refreshFailures += 1;
      if (Date.now() >= entry.expiresAt) {
        // Lease deadline passed: degrade to lazy blocking re-resolve on next use.
        entry.stale = true;
        this.logger.warn('secret refresh failed past lease deadline; marked stale', {
          connection: connectionKey,
          failures: entry.refreshFailures,
          err,
        });
        return;
      }
      const backoff =
        RETRY_BACKOFF_MS[Math.min(entry.refreshFailures - 1, RETRY_BACKOFF_MS.length - 1)] ?? 120_000;
      const delay = Math.min(backoff, Math.max(1_000, entry.expiresAt - Date.now()));
      this.logger.warn('secret refresh failed; retrying', {
        connection: connectionKey,
        failures: entry.refreshFailures,
        retryInMs: delay,
        err,
      });
      entry.timer = setTimeout(() => void this.refresh(connectionKey), delay);
      entry.timer.unref();
    }
  }
}
