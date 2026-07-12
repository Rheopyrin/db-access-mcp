import { getPlatform } from '../platform/platform';

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Best-effort process start time (epoch ms); undefined when unobtainable. */
export function getProcessStartTimeMs(pid: number): Promise<number | undefined> {
  return getPlatform().getProcessStartTimeMs(pid);
}

/** Best-effort full command line; undefined when unobtainable. */
export function getProcessCommandLine(pid: number): Promise<string | undefined> {
  return getPlatform().getProcessCommandLine(pid);
}

/** Kills a tunnel process (tree on Windows); best effort, never throws. */
export function killTunnelPid(pid: number): Promise<void> {
  return getPlatform().killTunnelPid(pid);
}
