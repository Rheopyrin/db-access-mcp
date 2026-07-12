import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { instancesDir } from '../../src/config/paths';
import { InstanceRegistry } from '../../src/instances/instance-registry';
import { sweepDeadInstances, type SweepDeps } from '../../src/instances/sweep';
import { StderrLogger } from '../../src/logging/logger';

const logger = new StderrLogger('silent');
const OWN_PID = 99_999;

function makeDeps(overrides: Partial<SweepDeps> = {}): SweepDeps & { killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    isAlive: () => false,
    getStartTimeMs: async () => undefined,
    getCommandLine: async () => 'node watchdog.js -- aws ssm start-session',
    kill: async (pid) => {
      killed.push(pid);
    },
    ...overrides,
  };
}

function writeInstanceFile(workdir: string, pid: number, startTimeMs: number, tunnelPids: number[]): string {
  const dir = instancesDir(workdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pid}-${startTimeMs}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid,
      startTimeMs,
      tunnels: [{ cacheKey: 't1|h:5432', tunnelName: 't1', tunnelType: 'ssm', localPort: 21000, pids: tunnelPids }],
    }),
  );
  return file;
}

describe('sweepDeadInstances', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
  });

  it('kills tunnels of dead instances and removes their files', async () => {
    const file = writeInstanceFile(workdir, 1234, Date.now(), [5555, 5556]);
    const deps = makeDeps({
      isAlive: (pid) => pid !== 1234, // instance dead, tunnel pids alive
    });
    await sweepDeadInstances(workdir, logger, OWN_PID, deps);
    expect(deps.killed).toEqual([5555, 5556]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('leaves alive instances untouched', async () => {
    const start = Date.now();
    const file = writeInstanceFile(workdir, 1234, start, [5555]);
    const deps = makeDeps({
      isAlive: () => true,
      getStartTimeMs: async () => start + 2_000, // within tolerance
    });
    await sweepDeadInstances(workdir, logger, OWN_PID, deps);
    expect(deps.killed).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('treats a reused PID (start time mismatch) as dead', async () => {
    const file = writeInstanceFile(workdir, 1234, Date.now() - 3_600_000, [5555]);
    const deps = makeDeps({
      isAlive: () => true,
      getStartTimeMs: async () => Date.now(), // different process now owns the pid
    });
    await sweepDeadInstances(workdir, logger, OWN_PID, deps);
    expect(deps.killed).toEqual([5555]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never kills when the OS start time is unobtainable but the pid is alive', async () => {
    const file = writeInstanceFile(workdir, 1234, Date.now() - 3_600_000, [5555]);
    const deps = makeDeps({
      isAlive: () => true,
      getStartTimeMs: async () => undefined,
    });
    await sweepDeadInstances(workdir, logger, OWN_PID, deps);
    expect(deps.killed).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('skips tunnel pids whose command line does not look like a tunnel process', async () => {
    const file = writeInstanceFile(workdir, 1234, Date.now(), [5555]);
    const deps = makeDeps({
      isAlive: (pid) => pid === 5555,
      getCommandLine: async () => '/usr/bin/some-unrelated-daemon --port 8080',
    });
    await sweepDeadInstances(workdir, logger, OWN_PID, deps);
    expect(deps.killed).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes corrupt instance files without killing anything', async () => {
    const dir = instancesDir(workdir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `1234-${Date.now()}.json`);
    fs.writeFileSync(file, '{not json');
    const deps = makeDeps();
    await sweepDeadInstances(workdir, logger, OWN_PID, deps);
    expect(deps.killed).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('skips its own instance file and non-instance files', async () => {
    const ownFile = writeInstanceFile(workdir, OWN_PID, Date.now(), [5555]);
    const junk = path.join(instancesDir(workdir), 'readme.txt');
    fs.writeFileSync(junk, 'hello');
    const deps = makeDeps();
    await sweepDeadInstances(workdir, logger, OWN_PID, deps);
    expect(fs.existsSync(ownFile)).toBe(true);
    expect(fs.existsSync(junk)).toBe(true);
    expect(deps.killed).toEqual([]);
  });
});

describe('InstanceRegistry', () => {
  it('writes, updates and deletes its instance file', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
    const registry = new InstanceRegistry(workdir, logger, 4321, 1_700_000_000_000);
    registry.init();
    expect(fs.existsSync(registry.filePath)).toBe(true);

    registry.recordTunnel({ cacheKey: 'k', tunnelName: 't1', tunnelType: 'ssm', localPort: 21000, pids: [1, 2] });
    let content = JSON.parse(fs.readFileSync(registry.filePath, 'utf8'));
    expect(content.tunnels).toHaveLength(1);
    expect(content.pid).toBe(4321);

    registry.removeTunnel('k');
    content = JSON.parse(fs.readFileSync(registry.filePath, 'utf8'));
    expect(content.tunnels).toHaveLength(0);

    registry.delete();
    expect(fs.existsSync(registry.filePath)).toBe(false);
  });
});
