import type { Logger } from './interfaces/logger';

type Hook = { name: string; fn: () => void | Promise<void> };

/**
 * Ordered graceful shutdown: hooks run in registration order, each capped so a
 * hung pool cannot block tunnel cleanup. SIGKILL is handled elsewhere (tunnel
 * watchdogs + next-startup sweep).
 */
export class ShutdownManager {
  private readonly hooks: Hook[] = [];
  private running = false;

  constructor(
    private readonly logger: Logger,
    private readonly hookTimeoutMs = 10_000,
  ) {}

  register(name: string, fn: () => void | Promise<void>): void {
    this.hooks.push({ name, fn });
  }

  installSignalHandlers(): void {
    const handler = (signal: string) => {
      this.logger.info('shutdown signal received', { signal });
      void this.run().then(() => process.exit(0));
    };
    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    for (const { name, fn } of this.hooks) {
      try {
        await Promise.race([
          Promise.resolve(fn()),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`shutdown hook "${name}" timed out`)), this.hookTimeoutMs).unref(),
          ),
        ]);
      } catch (err) {
        this.logger.warn('shutdown hook failed', { hook: name, err });
      }
    }
  }
}
