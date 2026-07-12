import { PosixPlatform } from './posix';
import { Win32Platform } from './win32';

/**
 * Platform abstraction: every win32/posix difference lives behind this
 * interface (src/platform/win32.ts and src/platform/posix.ts).
 *
 * The only intentional exception is src/bin/watchdog.ts — it must stay a
 * dependency-free standalone build entry, so it carries its own inline
 * platform switches.
 */
export interface PlatformOps {
  /** Best-effort process start time (epoch ms); undefined when unobtainable. */
  getProcessStartTimeMs(pid: number): Promise<number | undefined>;
  /** Best-effort full command line; undefined when unobtainable. */
  getProcessCommandLine(pid: number): Promise<string | undefined>;
  /** Kills a tunnel process (whole tree where the OS requires it); never throws. */
  killTunnelPid(pid: number): Promise<void>;
  /** Default SSH agent socket/pipe when `agent: true` is configured. */
  defaultSshAgent(): string | undefined;
  /** Command names to try for the AWS CLI, in order. */
  awsCommandCandidates(): string[];
}

let current: PlatformOps | undefined;

export function getPlatform(): PlatformOps {
  current ??= process.platform === 'win32' ? new Win32Platform() : new PosixPlatform();
  return current;
}

/** Test hook: replace the platform implementation (undefined restores auto-detection). */
export function setPlatform(ops: PlatformOps | undefined): void {
  current = ops;
}
