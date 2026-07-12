import type { ConfigService } from '../config/config.service';
import type { DialectRegistry } from '../composition/registries';
import { DbAccessError, isDbAccessError } from '../errors';
import type { DbPool } from '../interfaces/dialect-driver';
import type { Logger } from '../interfaces/logger';
import type { ConnectionTunnels } from '../interfaces/tunnel-provider';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { PoolManager } from './pool-manager';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

export interface QueryExecutorDeps {
  configService: ConfigService;
  dialects: DialectRegistry;
  poolManager: PoolManager;
  secretsManager: SecretsManager;
  logger: Logger;
  tunnels?: ConnectionTunnels;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs work against a connection's pool with the reconnect policy:
 * only connection-class errors retry (3 attempts, exponential backoff with
 * jitter); before each retry the tunnel is health-checked and reopened and the
 * pool recreated. Auth errors never retry — retrying can lock accounts.
 */
export class QueryExecutor {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: QueryExecutorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  setConnectionTunnels(tunnels: ConnectionTunnels): void {
    this.deps.tunnels = tunnels;
  }

  async execute<T>(
    connectionKey: string,
    work: (pool: DbPool) => Promise<T>,
    opts: { database?: string } = {},
  ): Promise<T> {
    const conn = this.deps.configService.getConnection(connectionKey);
    const driver = this.deps.dialects.get(conn.type);
    const database = opts.database;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const pool = await this.deps.poolManager.acquire(connectionKey, database);
        this.deps.poolManager.touch(connectionKey, database);
        return await work(pool);
      } catch (err) {
        lastError = err;
        if (isDbAccessError(err)) throw err; // already classified (config/tunnel/secret errors)
        if (driver.isTimeoutError(err)) {
          throw new DbAccessError('QUERY_TIMEOUT', `query timed out: ${(err as Error).message}`, {
            hint: 'Increase timeout_ms or add LIMIT / narrower predicates to the query.',
            cause: err,
          });
        }
        const errorClass = driver.classifyError(err);
        if (errorClass === 'auth') {
          // Exception to no-retry-on-auth: stale credentials (a failed lease
          // refresh) may simply need a fresh resolve.
          if (this.deps.secretsManager.isStale(connectionKey) && attempt < MAX_ATTEMPTS) {
            this.deps.logger.info('auth failure with stale secret; re-resolving credentials', {
              connection: connectionKey,
            });
            await this.deps.secretsManager.forceResolve(connectionKey);
            await this.deps.poolManager.recreate(connectionKey, database);
            continue;
          }
          throw new DbAccessError('CONNECTION_FAILED', `authentication failed: ${(err as Error).message}`, {
            hint: 'Check the configured credentials / secret values. Auth errors are not retried.',
            cause: err,
          });
        }
        if (errorClass !== 'connection' || attempt === MAX_ATTEMPTS) {
          throw this.wrapFinal(errorClass, err);
        }
        this.deps.logger.warn('connection error; retrying', {
          connection: connectionKey,
          attempt,
          message: (err as Error).message,
        });
        await this.heal(connectionKey, conn.tunnel !== undefined, database);
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 250;
        await this.sleep(backoff);
      }
    }
    /* c8 ignore next */
    throw this.wrapFinal('connection', lastError);
  }

  private wrapFinal(errorClass: string, err: unknown): DbAccessError {
    const message = (err as Error)?.message ?? String(err);
    if (errorClass === 'connection') {
      return new DbAccessError('CONNECTION_FAILED', `database unreachable: ${message}`, { cause: err });
    }
    return new DbAccessError('QUERY_FAILED', message, { cause: err });
  }

  /** Cheapest-first healing before a retry: tunnel health, then stale secrets. */
  private async heal(connectionKey: string, hasTunnel: boolean, database?: string): Promise<void> {
    try {
      if (hasTunnel && this.deps.tunnels) {
        const healthy = await this.deps.tunnels.isHealthy(connectionKey);
        if (!healthy) {
          this.deps.logger.info('tunnel unhealthy; reopening', { connection: connectionKey });
          await this.deps.tunnels.reopen(connectionKey);
          await this.deps.poolManager.recreate(connectionKey, database);
          return;
        }
      }
      if (this.deps.secretsManager.isStale(connectionKey)) {
        await this.deps.secretsManager.forceResolve(connectionKey);
        await this.deps.poolManager.recreate(connectionKey, database);
        return;
      }
      // The pool itself may hold broken sockets — rebuild it on the same endpoint.
      await this.deps.poolManager.recreate(connectionKey, database);
    } catch (err) {
      this.deps.logger.warn('heal step failed; retry will attempt anyway', { connection: connectionKey, err });
    }
  }
}
