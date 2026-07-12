import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlatformOps } from './platform';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 5_000;

export class PosixPlatform implements PlatformOps {
  async getProcessStartTimeMs(pid: number): Promise<number | undefined> {
    try {
      // lstart works on both linux and macOS ps.
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: EXEC_TIMEOUT_MS,
      });
      const text = stdout.trim();
      if (text === '') return undefined;
      const parsed = Date.parse(text);
      return Number.isNaN(parsed) ? undefined : parsed;
    } catch {
      return undefined;
    }
  }

  async getProcessCommandLine(pid: number): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], {
        timeout: EXEC_TIMEOUT_MS,
      });
      const text = stdout.trim();
      return text === '' ? undefined : text;
    } catch {
      return undefined;
    }
  }

  async killTunnelPid(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone or not permitted */
    }
  }

  defaultSshAgent(): string | undefined {
    return process.env['SSH_AUTH_SOCK'];
  }

  awsCommandCandidates(): string[] {
    return ['aws'];
  }
}
