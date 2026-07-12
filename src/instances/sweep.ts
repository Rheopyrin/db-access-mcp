import fs from 'node:fs';
import path from 'node:path';
import { instancesDir } from '../config/paths';
import type { Logger } from '../interfaces/logger';
import { INSTANCE_FILE_RE, type InstanceFile } from './instance-registry';
import { getProcessCommandLine, getProcessStartTimeMs, isPidAlive, killTunnelPid } from './process-utils';

/** Recorded vs. OS start time tolerance (registry stamps Date.now() slightly after exec). */
const START_TIME_TOLERANCE_MS = 15_000;
const TUNNEL_CMDLINE_RE = /watchdog\.js|aws(\.exe|\.cmd)?["']?\s+ssm|session-manager-plugin|start-session/i;

export interface SweepDeps {
  isAlive(pid: number): boolean;
  getStartTimeMs(pid: number): Promise<number | undefined>;
  getCommandLine(pid: number): Promise<string | undefined>;
  kill(pid: number): Promise<void>;
}

const realDeps: SweepDeps = {
  isAlive: isPidAlive,
  getStartTimeMs: getProcessStartTimeMs,
  getCommandLine: getProcessCommandLine,
  kill: killTunnelPid,
};

/**
 * Kills tunnels orphaned by crashed/killed MCP instances and removes their
 * registry files. Runs at every instance start (and periodically). Safe to run
 * concurrently from multiple instances: kills are idempotent and unlink
 * ignores ENOENT.
 */
export async function sweepDeadInstances(
  workdir: string,
  logger: Logger,
  ownPid: number = process.pid,
  deps: SweepDeps = realDeps,
): Promise<void> {
  const dir = instancesDir(workdir);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return; // no instances dir yet
  }

  for (const file of files) {
    const match = INSTANCE_FILE_RE.exec(file);
    if (!match) continue;
    const pid = Number(match[1]);
    const startTimeMs = Number(match[2]);
    if (pid === ownPid) continue;

    if (await isInstanceAlive(pid, startTimeMs, deps)) continue;

    const filePath = path.join(dir, file);
    logger.info('sweeping dead MCP instance', { pid, file });
    await killRecordedTunnels(filePath, logger, deps);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('could not remove instance file', { file: filePath, err });
      }
    }
  }
}

async function isInstanceAlive(pid: number, recordedStartMs: number, deps: SweepDeps): Promise<boolean> {
  if (!deps.isAlive(pid)) return false;
  // PID-reuse guard: a live process with a different start time is not our instance.
  const osStartMs = await deps.getStartTimeMs(pid);
  if (osStartMs === undefined) return true; // uncertain — never kill on uncertainty
  return Math.abs(osStartMs - recordedStartMs) <= START_TIME_TOLERANCE_MS;
}

async function killRecordedTunnels(filePath: string, logger: Logger, deps: SweepDeps): Promise<void> {
  let parsed: InstanceFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as InstanceFile;
  } catch {
    logger.warn('corrupt instance file; removing without tunnel cleanup', { file: filePath });
    return;
  }
  for (const tunnel of parsed.tunnels ?? []) {
    for (const pid of tunnel.pids ?? []) {
      if (!deps.isAlive(pid)) continue;
      // Verify the command line looks like one of our tunnel processes —
      // never kill an unrelated process that happens to reuse the PID.
      const cmdline = await deps.getCommandLine(pid);
      if (cmdline === undefined || !TUNNEL_CMDLINE_RE.test(cmdline)) {
        logger.warn('skipping pid: command line does not look like a tunnel process', { pid, cmdline });
        continue;
      }
      logger.info('killing orphaned tunnel process', { pid, tunnel: tunnel.tunnelName, localPort: tunnel.localPort });
      await deps.kill(pid);
    }
  }
}
