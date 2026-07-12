import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WATCHDOG = path.join(repoRoot, 'dist', 'watchdog.js');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

/**
 * The orphan-prevention guarantee: when the process that spawned the watchdog
 * dies abruptly (SIGKILL — no handlers can run), the watchdog must kill the
 * wrapped tunnel process tree.
 */
describe('watchdog', () => {
  it('kills the wrapped child when the parent is SIGKILLed', async () => {
    // Holder simulates the MCP instance: it spawns the watchdog around a
    // long-running child and reports pids on stdout.
    const holderScript = `
      const { spawn } = require('node:child_process');
      const wd = spawn(process.execPath, [${JSON.stringify(WATCHDOG)}, '--',
        process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        { stdio: ['pipe', 'pipe', 'inherit'] });
      wd.stdout.on('data', (d) => process.stdout.write(d));
      setInterval(() => {}, 1000);
    `;
    const holderPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-')), 'holder.cjs');
    fs.writeFileSync(holderPath, holderScript);
    const holder = spawn(process.execPath, [holderPath], { stdio: ['ignore', 'pipe', 'inherit'] });

    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no childPid within 10s')), 10_000);
      let buf = '';
      holder.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const line = buf.split('\n')[0];
        if (buf.includes('\n') && line) {
          clearTimeout(timer);
          resolve((JSON.parse(line) as { childPid: number }).childPid);
        }
      });
    });
    expect(isAlive(childPid)).toBe(true);

    holder.kill('SIGKILL');
    expect(await waitForDeath(childPid, 5_000)).toBe(true);
  }, 30_000);

  it('kills the child on SIGTERM (graceful close path)', async () => {
    const wd = spawn(
      process.execPath,
      [WATCHDOG, '--', process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const childPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no childPid within 10s')), 10_000);
      let buf = '';
      wd.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('\n')) {
          clearTimeout(timer);
          resolve((JSON.parse(buf.split('\n')[0] as string) as { childPid: number }).childPid);
        }
      });
    });
    expect(isAlive(childPid)).toBe(true);
    wd.kill('SIGTERM');
    expect(await waitForDeath(childPid, 5_000)).toBe(true);
  }, 30_000);
});
