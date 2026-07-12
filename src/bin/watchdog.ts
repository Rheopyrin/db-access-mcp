/**
 * Watchdog wrapper for external tunnel processes (aws ssm start-session).
 *
 * Contract:
 *  - invoked as: node watchdog.js -- <cmd> [args...]
 *  - the parent holds our stdin pipe open and never writes; when the parent
 *    dies for ANY reason (including SIGKILL) the OS closes the pipe and we
 *    kill the child process tree — this is the orphan-prevention guarantee;
 *  - the first (and only) stdout line is JSON: {"childPid": N}; all child
 *    output is forwarded to stderr;
 *  - SIGTERM/SIGINT also kill the tree (graceful close path);
 *  - we exit when the child exits.
 *
 * This file must stay dependency-free: it is a standalone build entry.
 */
import { spawn, spawnSync } from 'node:child_process';

const sep = process.argv.indexOf('--');
if (sep === -1 || sep === process.argv.length - 1) {
  process.stderr.write('usage: watchdog.js -- <cmd> [args...]\n');
  process.exit(2);
}
const cmd = process.argv[sep + 1] as string;
const args = process.argv.slice(sep + 2);
const isWin = process.platform === 'win32';

const child = spawn(cmd, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  // POSIX: own process group so we can kill the whole tree with kill(-pid).
  detached: !isWin,
  windowsHide: true,
});

child.on('error', (err) => {
  process.stderr.write(`watchdog: failed to spawn ${cmd}: ${err.message}\n`);
  process.exit(1);
});

child.once('spawn', () => {
  process.stdout.write(`${JSON.stringify({ childPid: child.pid })}\n`);
});

child.stdout?.pipe(process.stderr);
child.stderr?.pipe(process.stderr);

let killing = false;
function killTree(reason: string): void {
  if (killing) return;
  killing = true;
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    process.exit(0);
  }
  process.stderr.write(`watchdog: killing child tree (pid ${pid}): ${reason}\n`);
  if (isWin) {
    // /T kills the whole tree (session-manager-plugin grandchildren included).
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    process.exit(0);
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* group already gone */
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
    process.exit(0);
  }, 3_000);
  escalate.unref();
}

// Core guarantee: parent death (any cause) closes this pipe.
process.stdin.resume();
process.stdin.on('end', () => killTree('parent stdin closed'));
process.stdin.on('close', () => killTree('parent stdin closed'));
process.stdin.on('error', () => killTree('parent stdin error'));

process.on('SIGTERM', () => killTree('SIGTERM'));
process.on('SIGINT', () => killTree('SIGINT'));

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
  // Give piped output a tick to flush, then exit.
  setTimeout(() => process.exit(), 100).unref();
});
