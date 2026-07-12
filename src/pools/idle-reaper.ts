import type { ConfigService } from '../config/config.service';
import type { Logger } from '../interfaces/logger';
import type { PoolManager } from './pool-manager';

/**
 * Per-instance idle timer: pools unused longer than the connection's
 * idle_close_ms are closed, which also releases their tunnel reference
 * (closing the tunnel when nothing else uses it).
 */
export class IdleReaper {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    private readonly poolManager: PoolManager,
    private readonly logger: Logger,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async check(now: number = Date.now()): Promise<void> {
    for (const { connectionKey, database, lastUsedAt } of this.poolManager.openEntries()) {
      const idleCloseMs = this.configService.effectiveLimits(connectionKey).idle_close_ms;
      if (now - lastUsedAt >= idleCloseMs) {
        this.logger.info('closing idle pool', { connection: connectionKey, database, idleMs: now - lastUsedAt });
        // Releases the tunnel ref too, once the connection's last pool closes.
        await this.poolManager.close(connectionKey, { database });
      }
    }
  }
}
