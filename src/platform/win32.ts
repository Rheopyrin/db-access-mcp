import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlatformOps } from './platform';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 5_000;

export class Win32Platform implements PlatformOps {
  async getProcessStartTimeMs(pid: number): Promise<number | undefined> {
    try {
      // PowerShell, not wmic — wmic is removed from current Windows 11 builds.
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
      const parsed = Date.parse(stdout.trim());
      return Number.isNaN(parsed) ? undefined : parsed;
    } catch {
      return undefined;
    }
  }

  async getProcessCommandLine(pid: number): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
      );
      const text = stdout.trim();
      return text === '' ? undefined : text;
    } catch {
      return undefined;
    }
  }

  async killTunnelPid(pid: number): Promise<void> {
    try {
      // Killing a PID does not kill its children on Windows: /T takes the tree.
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch {
      /* already gone or not permitted */
    }
  }

  defaultSshAgent(): string | undefined {
    return '\\\\.\\pipe\\openssh-ssh-agent';
  }

  awsCommandCandidates(): string[] {
    // AWS CLI v2 is aws.exe (spawn resolves .exe via PATH); v1 is aws.cmd which
    // spawn cannot start without an explicit extension.
    return ['aws', 'aws.cmd'];
  }
}
