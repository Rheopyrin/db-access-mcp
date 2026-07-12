import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DbAccessError } from '../errors';
import { getProcessStartTimeMs, isPidAlive } from '../instances/process-utils';
import type { Logger } from '../interfaces/logger';
import { getPlatform } from '../platform/platform';

const execFileAsync = promisify(execFile);

const CHECK_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 3_000;
const START_TIME_TOLERANCE_MS = 10_000;

export interface SsoEnsureRequest {
  /** sso-session name; when set, login runs `aws sso login --sso-session <name>`. */
  session?: string;
  /** AWS profile: always used for the sts liveness check; login fallback when no session. */
  profile?: string;
  timeoutMs: number;
}

/** Result of a session check. */
export type SessionCheck = { ok: true } | { ok: false; message: string };

export interface SsoLoginTarget {
  session?: string;
  profile?: string;
}

export interface SsoCommandRunner {
  /** Runs `aws sts get-caller-identity` for the profile. */
  checkSession(profile: string | undefined): Promise<SessionCheck>;
  /**
   * Starts `aws sso login` detached (never killed by us — the session and the
   * browser flow must survive this MCP instance). Resolves handlers for early
   * failure detection.
   */
  startLogin(target: SsoLoginTarget): { onExit: Promise<{ code: number | null; stderrTail: string }> };
}

/**
 * Whether a failed `aws sts get-caller-identity` looks like an expired/invalid
 * SSO session (the only case that warrants an interactive `aws sso login`).
 * Network blips, a missing CLI, wrong region or permission errors must NOT pop
 * a browser — they surface as a plain failure instead.
 */
export function looksLikeExpiredSession(message: string): boolean {
  return /token (has )?expired|token .*does not exist|refresh failed|sso session .*(expired|invalid)|the sso session associated|credentials? .*expired|expiredtoken|session .*(expired|invalid)|re-?authenticate|aws sso login/i.test(
    message,
  );
}

/** `--sso-session` wins over `--profile`; bare `aws sso login` otherwise. */
function loginArgs(target: SsoLoginTarget): string[] {
  if (target.session) return ['sso', 'login', '--sso-session', target.session];
  if (target.profile) return ['sso', 'login', '--profile', target.profile];
  return ['sso', 'login'];
}

function loginCommandText(target: SsoLoginTarget): string {
  return `aws ${loginArgs(target).join(' ')}`;
}

function defaultRunner(logger: Logger): SsoCommandRunner {
  let resolvedAws: string | undefined;
  const awsCmd = async (): Promise<string> => {
    if (resolvedAws) return resolvedAws;
    // Probe the platform candidates once (aws.exe vs aws.cmd on Windows).
    for (const candidate of getPlatform().awsCommandCandidates()) {
      try {
        await execFileAsync(candidate, ['--version'], { timeout: CHECK_TIMEOUT_MS, windowsHide: true });
        resolvedAws = candidate;
        return candidate;
      } catch {
        /* try the next candidate */
      }
    }
    resolvedAws = 'aws';
    return resolvedAws;
  };
  return {
    async checkSession(profile) {
      const args = ['sts', 'get-caller-identity', '--output', 'json', ...(profile ? ['--profile', profile] : [])];
      try {
        await execFileAsync(await awsCmd(), args, { timeout: CHECK_TIMEOUT_MS, windowsHide: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    },
    startLogin(target) {
      const args = loginArgs(target);
      const child = spawn(resolvedAws ?? 'aws', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let stderrTail = '';
      const forward = (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim();
        if (text !== '') logger.info('aws sso login output', { sso: target.session ?? target.profile, output: text });
      };
      child.stdout?.on('data', forward);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2_000);
        forward(chunk);
      });
      const onExit = new Promise<{ code: number | null; stderrTail: string }>((resolve) => {
        child.on('error', (err) => resolve({ code: 127, stderrTail: err.message }));
        child.on('exit', (code) => resolve({ code, stderrTail }));
      });
      // The login must survive us: no watchdog, no kill on shutdown.
      child.unref();
      return { onExit };
    },
  };
}

interface LoginMarker {
  pid: number;
  startTimeMs: number;
}

/**
 * Ensures a live AWS SSO session before an SSM tunnel opens.
 *
 * - session valid -> no-op;
 * - otherwise start `aws sso login` (browser flow) and poll sts until the
 *   session works or timeoutMs elapses;
 * - concurrent requests for the same profile share one login (in-process
 *   promise + a cross-instance marker file under <workdir>/sso/);
 * - the session is NEVER closed or invalidated by this server.
 */
export class SsoSessionManager {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly runner: SsoCommandRunner;

  constructor(
    private readonly workdir: string,
    private readonly logger: Logger,
    runner?: SsoCommandRunner,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
  ) {
    this.runner = runner ?? defaultRunner(logger);
  }

  async ensureSession(request: SsoEnsureRequest): Promise<void> {
    // One login per sso-session (a session may back several profiles).
    const key = request.session ?? request.profile ?? '(default)';
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.doEnsure(request, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async doEnsure(request: SsoEnsureRequest, key: string): Promise<void> {
    const first = await this.runner.checkSession(request.profile);
    if (first.ok) return;

    const target: SsoLoginTarget = { session: request.session, profile: request.profile };
    const manualCommand = loginCommandText(target);

    // Only an expired/invalid session should trigger the browser login. A
    // transient failure (network, wrong region, missing CLI) must not.
    if (!looksLikeExpiredSession(first.message)) {
      throw new DbAccessError(
        'TUNNEL_FAILED',
        `aws sts check failed for "${key}" and does not look like an expired SSO session: ${first.message}`,
        { hint: `Check AWS connectivity/region/credentials, or run "${manualCommand}" manually and retry.` },
      );
    }
    this.logger.info('sso session invalid or expired', { sso: key, reason: first.message });

    const deadline = Date.now() + request.timeoutMs;
    const otherLoginAlive = await this.isForeignLoginInProgress(key);

    let onExit: Promise<{ code: number | null; stderrTail: string }> | undefined;
    let markerOwned = false;
    if (otherLoginAlive) {
      this.logger.info('another instance is running aws sso login; waiting for the session', { sso: key });
    } else {
      this.writeMarker(key);
      markerOwned = true;
      this.logger.info('starting aws sso login', { sso: key, command: manualCommand, timeoutMs: request.timeoutMs });
      onExit = this.runner.startLogin(target).onExit;
    }

    try {
      let exited: { code: number | null; stderrTail: string } | undefined;
      void onExit?.then((result) => {
        exited = result;
      });
      for (;;) {
        if (exited && exited.code !== null && exited.code !== 0) {
          throw new DbAccessError(
            'TUNNEL_FAILED',
            `aws sso login failed for "${key}" (exit ${exited.code}): ${exited.stderrTail.trim()}`,
            { hint: `Run "${manualCommand}" manually to diagnose.` },
          );
        }
        const check = await this.runner.checkSession(request.profile);
        if (check.ok) {
          this.logger.info('sso session ready', { sso: key });
          return;
        }
        if (Date.now() >= deadline) {
          throw new DbAccessError(
            'TUNNEL_FAILED',
            `aws sso login timed out after ${request.timeoutMs}ms for "${key}"`,
            { hint: `Complete the browser login, or run "${manualCommand}" manually and retry.` },
          );
        }
        await this.sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
      }
    } finally {
      if (markerOwned) this.removeMarker(key);
    }
  }

  private markerPath(key: string): string {
    const sanitized = key.replace(/[^\w.-]/g, '_');
    return path.join(this.workdir, 'sso', `${sanitized}.login.json`);
  }

  private writeMarker(key: string): void {
    try {
      const file = this.markerPath(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, startTimeMs: Date.now() } satisfies LoginMarker));
      fs.renameSync(tmp, file);
    } catch (err) {
      // The marker is a cross-instance courtesy, not a correctness requirement.
      this.logger.warn('failed to write sso login marker', { profile: key, err });
    }
  }

  private removeMarker(key: string): void {
    try {
      fs.unlinkSync(this.markerPath(key));
    } catch {
      /* already gone */
    }
  }

  /** True when a marker exists and its owner process is verifiably alive. */
  private async isForeignLoginInProgress(key: string): Promise<boolean> {
    let marker: LoginMarker;
    try {
      marker = JSON.parse(fs.readFileSync(this.markerPath(key), 'utf8')) as LoginMarker;
    } catch {
      return false;
    }
    if (marker.pid === process.pid) return false;
    if (!isPidAlive(marker.pid)) return false;
    // PID-reuse guard: the owner process must have existed when the marker was
    // written, i.e. its start time is not AFTER the marker timestamp.
    // Unobtainable start time counts as alive (conservative, like the sweep).
    const startTime = await getProcessStartTimeMs(marker.pid);
    if (startTime !== undefined && startTime > marker.startTimeMs + START_TIME_TOLERANCE_MS) {
      return false;
    }
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
