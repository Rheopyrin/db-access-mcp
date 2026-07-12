import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, instancesDir } from '../config/paths';
import type { Logger } from '../interfaces/logger';
import type { TunnelRegistrar } from '../tunnels/tunnel-manager';

export interface RegisteredTunnel {
  cacheKey: string;
  tunnelName: string;
  tunnelType: string;
  localPort: number;
  pids: number[];
}

export interface InstanceFile {
  pid: number;
  startTimeMs: number;
  tunnels: RegisteredTunnel[];
}

export const INSTANCE_FILE_RE = /^(\d+)-(\d+)\.json$/;

/**
 * Per-instance registry file: <workdir>/instances/<pid>-<startTimeMs>.json.
 * Per-instance files (instead of one shared locked file) make concurrent
 * instances trivially safe — no lock contention, no stale-lock recovery.
 * Writes are atomic (tmp sibling + rename). The file only matters after a
 * crash: the startup sweep of any later instance kills recorded tunnel PIDs.
 */
export class InstanceRegistry implements TunnelRegistrar {
  private readonly tunnels = new Map<string, RegisteredTunnel>();
  readonly filePath: string;

  constructor(
    private readonly workdir: string,
    private readonly logger: Logger,
    readonly pid: number = process.pid,
    readonly startTimeMs: number = Date.now(),
  ) {
    this.filePath = path.join(instancesDir(workdir), `${pid}-${startTimeMs}.json`);
  }

  /** Creates the instance file immediately — it marks this instance as alive. */
  init(): void {
    ensureDir(instancesDir(this.workdir));
    this.flush();
  }

  recordTunnel(entry: RegisteredTunnel): void {
    this.tunnels.set(entry.cacheKey, entry);
    this.flush();
  }

  removeTunnel(cacheKey: string): void {
    if (this.tunnels.delete(cacheKey)) this.flush();
  }

  /** Graceful shutdown: nothing left to clean up after this instance. */
  delete(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('could not delete instance file', { file: this.filePath, err });
      }
    }
  }

  private flush(): void {
    const payload: InstanceFile = {
      pid: this.pid,
      startTimeMs: this.startTimeMs,
      tunnels: [...this.tunnels.values()],
    };
    // The tmp file sits next to the target: rename is atomic on the same volume.
    const tmpPath = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
      renameWithRetry(tmpPath, this.filePath);
    } catch (err) {
      this.logger.warn('could not write instance file', { file: this.filePath, err });
    }
  }
}

/** NTFS can throw EPERM on rename over an open file — retry once. */
function renameWithRetry(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    const start = Date.now();
    while (Date.now() - start < 100) {
      /* brief busy-wait; sync context */
    }
    fs.renameSync(from, to);
  }
}
