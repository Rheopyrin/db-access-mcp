import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config.service';
import { StderrLogger } from '../../src/logging/logger';
import {
  looksLikeExpiredSession,
  SsoSessionManager,
  type SsoCommandRunner,
  type SessionCheck,
} from '../../src/tunnels/sso-session';

const logger = new StderrLogger('silent');

interface FakeRunnerOptions {
  /** Sequence of check results; the last one repeats forever. */
  checks: SessionCheck[];
  loginExit?: Promise<{ code: number | null; stderrTail: string }>;
}

function fakeRunner(opts: FakeRunnerOptions) {
  let checkIndex = 0;
  const state = {
    checkCalls: 0,
    loginStarts: 0,
    loginTargets: [] as { session?: string; profile?: string }[],
    checkedProfiles: [] as (string | undefined)[],
  };
  const runner: SsoCommandRunner = {
    async checkSession(profile) {
      state.checkCalls += 1;
      state.checkedProfiles.push(profile);
      const result = opts.checks[Math.min(checkIndex, opts.checks.length - 1)]!;
      checkIndex += 1;
      return result;
    },
    startLogin(target) {
      state.loginStarts += 1;
      state.loginTargets.push(target);
      return { onExit: opts.loginExit ?? new Promise(() => {}) };
    },
  };
  return { runner, state };
}

function manager(runner: SsoCommandRunner, workdir?: string): { mgr: SsoSessionManager; workdir: string } {
  const wd = workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sso-'));
  return { mgr: new SsoSessionManager(wd, logger, runner, 5), workdir: wd };
}

const invalid: SessionCheck = { ok: false, message: 'The SSO session associated with this profile has expired' };
const valid: SessionCheck = { ok: true };

describe('SsoSessionManager', () => {
  it('does nothing when the session is already valid', async () => {
    const { runner, state } = fakeRunner({ checks: [valid] });
    const { mgr } = manager(runner);
    await mgr.ensureSession({ profile: 'prod', timeoutMs: 10_000 });
    expect(state.loginStarts).toBe(0);
    expect(state.checkCalls).toBe(1);
  });

  it('starts one login and polls until the session becomes valid; marker is created and removed', async () => {
    const { runner, state } = fakeRunner({ checks: [invalid, invalid, invalid, valid] });
    const { mgr, workdir } = manager(runner);
    const markerFile = path.join(workdir, 'sso', 'prod.login.json');

    const markerSeen = new Promise<boolean>((resolve) => {
      const timer = setInterval(() => {
        if (fs.existsSync(markerFile)) {
          clearInterval(timer);
          resolve(true);
        }
      }, 1);
      setTimeout(() => {
        clearInterval(timer);
        resolve(false);
      }, 2_000).unref();
    });

    await mgr.ensureSession({ profile: 'prod', timeoutMs: 10_000 });
    expect(state.loginStarts).toBe(1);
    expect(state.checkCalls).toBeGreaterThanOrEqual(4);
    expect(await markerSeen).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it('deduplicates concurrent ensureSession calls for the same profile', async () => {
    const { runner, state } = fakeRunner({ checks: [invalid, invalid, valid] });
    const { mgr } = manager(runner);
    await Promise.all([
      mgr.ensureSession({ profile: 'prod', timeoutMs: 10_000 }),
      mgr.ensureSession({ profile: 'prod', timeoutMs: 10_000 }),
      mgr.ensureSession({ profile: 'prod', timeoutMs: 10_000 }),
    ]);
    expect(state.loginStarts).toBe(1);
  });

  it('waits without spawning a login when another live instance holds the marker', async () => {
    const { runner: firstRunner } = fakeRunner({ checks: [invalid] });
    const { mgr: _first, workdir } = manager(firstRunner);
    // Simulate a foreign live instance: our own PID is excluded by the manager,
    // so use a definitely-alive foreign process (PID 1 / init or launchd).
    const markerFile = path.join(workdir, 'sso', 'prod.login.json');
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify({ pid: 1, startTimeMs: Date.now() }));

    const { runner, state } = fakeRunner({ checks: [invalid, invalid, valid] });
    const mgr = new SsoSessionManager(workdir, logger, runner, 5);
    await mgr.ensureSession({ profile: 'prod', timeoutMs: 10_000 });
    expect(state.loginStarts).toBe(0);
    expect(state.checkCalls).toBeGreaterThanOrEqual(3);
  });

  it('ignores a marker whose owner is dead and starts its own login', async () => {
    const { runner, state } = fakeRunner({ checks: [invalid, valid] });
    const { mgr, workdir } = manager(runner);
    const markerFile = path.join(workdir, 'sso', 'prod.login.json');
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    // PID that certainly does not exist.
    fs.writeFileSync(markerFile, JSON.stringify({ pid: 999_999_999 >>> 8, startTimeMs: Date.now() }));

    await mgr.ensureSession({ profile: 'prod', timeoutMs: 10_000 });
    expect(state.loginStarts).toBe(1);
  });

  it('fails with TUNNEL_FAILED on timeout and removes the marker', async () => {
    const { runner, state } = fakeRunner({ checks: [invalid] });
    const { mgr, workdir } = manager(runner);
    await expect(mgr.ensureSession({ profile: 'stuck', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'TUNNEL_FAILED',
      message: expect.stringContaining('stuck'),
      hint: expect.stringContaining('aws sso login'),
    });
    expect(state.loginStarts).toBe(1);
    expect(fs.existsSync(path.join(workdir, 'sso', 'stuck.login.json'))).toBe(false);
  });

  it('fails fast when the login process exits non-zero', async () => {
    const { runner } = fakeRunner({
      checks: [invalid],
      loginExit: Promise.resolve({ code: 1, stderrTail: 'SSO error: invalid_grant' }),
    });
    const { mgr } = manager(runner);
    const started = Date.now();
    await expect(mgr.ensureSession({ profile: 'prod', timeoutMs: 60_000 })).rejects.toMatchObject({
      code: 'TUNNEL_FAILED',
      message: expect.stringContaining('invalid_grant'),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('falls back to profile-based login when no session is configured', async () => {
    const { runner, state } = fakeRunner({ checks: [invalid, valid] });
    const { mgr } = manager(runner);
    await mgr.ensureSession({ profile: '946263819833_Admin', timeoutMs: 10_000 });
    expect(state.loginTargets).toEqual([{ session: undefined, profile: '946263819833_Admin' }]);
  });

  it('logs in via --sso-session when session is set, while sts checks use the profile', async () => {
    const { runner, state } = fakeRunner({ checks: [invalid, valid] });
    const { mgr, workdir } = manager(runner);
    await mgr.ensureSession({ session: 'drew', profile: '783188886076_Admin', timeoutMs: 10_000 });
    expect(state.loginTargets).toEqual([{ session: 'drew', profile: '783188886076_Admin' }]);
    expect(state.checkedProfiles.every((p) => p === '783188886076_Admin')).toBe(true);
    // Marker and dedup key by session name, not profile.
    expect(fs.existsSync(path.join(workdir, 'sso'))).toBe(true);
  });

  it('dedup key is the session: two profiles backed by one session share one login', async () => {
    const { runner, state } = fakeRunner({ checks: [invalid, invalid, valid] });
    const { mgr } = manager(runner);
    await Promise.all([
      mgr.ensureSession({ session: 'drew', profile: 'profile-a', timeoutMs: 10_000 }),
      mgr.ensureSession({ session: 'drew', profile: 'profile-b', timeoutMs: 10_000 }),
    ]);
    expect(state.loginStarts).toBe(1);
  });

  it('timeout errors mention the sso-session login command when session is set', async () => {
    const { runner } = fakeRunner({ checks: [invalid] });
    const { mgr } = manager(runner);
    await expect(mgr.ensureSession({ session: 'NcLabs', profile: 'x', timeoutMs: 30 })).rejects.toMatchObject({
      code: 'TUNNEL_FAILED',
      hint: expect.stringContaining('aws sso login --sso-session NcLabs'),
    });
  });

  it('uses "(default)" as the key when no profile is set', async () => {
    const { runner, state } = fakeRunner({ checks: [invalid] });
    const { mgr, workdir } = manager(runner);
    await expect(mgr.ensureSession({ timeoutMs: 30 })).rejects.toMatchObject({
      message: expect.stringContaining('(default)'),
    });
    expect(state.loginStarts).toBe(1);
    expect(fs.readdirSync(path.join(workdir, 'sso'))).toEqual([]);
  });
});

describe('looksLikeExpiredSession', () => {
  it('recognizes expired/invalid session phrasings', () => {
    expect(looksLikeExpiredSession('The SSO session associated with this profile has expired')).toBe(true);
    expect(looksLikeExpiredSession('Error loading SSO Token: Token for x does not exist')).toBe(true);
    expect(looksLikeExpiredSession('Token has expired and refresh failed')).toBe(true);
  });

  it('does not treat transient/CLI/permission errors as an expired session', () => {
    expect(looksLikeExpiredSession('Could not connect to the endpoint URL')).toBe(false);
    expect(looksLikeExpiredSession('aws: command not found')).toBe(false);
    expect(looksLikeExpiredSession('An error occurred (AccessDenied) when calling ...')).toBe(false);
  });
});

describe('SsoSessionManager transient failures', () => {
  it('surfaces a non-expiry sts failure without starting a browser login', async () => {
    const { runner, state } = fakeRunner({ checks: [{ ok: false, message: 'Could not connect to the endpoint URL' }] });
    const { mgr } = manager(runner);
    await expect(mgr.ensureSession({ profile: 'prod', timeoutMs: 10_000 })).rejects.toMatchObject({
      code: 'TUNNEL_FAILED',
      message: expect.stringContaining('does not look like an expired SSO session'),
    });
    expect(state.loginStarts).toBe(0);
  });
});

describe('sso config schema', () => {
  it('accepts sso on ssm tunnels with a default timeout', () => {
    const config = parseConfig({
      tunnels: { t1: { type: 'ssm', options: { target: 'i-1' }, sso: { profile: 'p' } } },
    });
    const tunnel = config.tunnels['t1']!;
    expect(tunnel.type === 'ssm' && tunnel.sso?.timeout_ms).toBe(300_000);
  });

  it('rejects sso on ssh tunnels and unknown sso keys', () => {
    expect(() =>
      parseConfig({ tunnels: { t1: { type: 'ssh', options: { host: 'h' }, sso: { profile: 'p' } } } }),
    ).toThrow();
    expect(() =>
      parseConfig({ tunnels: { t1: { type: 'ssm', options: { target: 'i-1' }, sso: { nope: 1 } } } }),
    ).toThrow();
  });
});
