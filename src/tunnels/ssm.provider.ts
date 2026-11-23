import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';
import type { TunnelHandle, TunnelOpenRequest, TunnelProvider } from '../interfaces/tunnel-provider';
import { getPlatform } from '../platform/platform';
import type { SsmTunnelOptions } from '../config/schema';
import { SsmTargetResolver } from './ssm-target-resolver';
import type { SsoSessionManager } from './sso-session';
import { tcpProbe, waitForTcp } from './tcp';

const DEFAULT_DOCUMENT = 'AWS-StartPortForwardingSessionToRemoteHost';

export function resolveWatchdogPath(): string {
  const override = process.env['DB_ACCESS_MCP_WATCHDOG_PATH'];
  if (override && fs.existsSync(override)) return override;
  // Bundled layout: cli.js and watchdog.js are siblings in dist/.
  const sibling = fileURLToPath(new URL('./watchdog.js', import.meta.url));
  if (fs.existsSync(sibling)) return sibling;
  // Dev layout (vitest runs from src/): use the built artifact.
  const fromSrc = fileURLToPath(new URL('../../dist/watchdog.js', import.meta.url));
  if (fs.existsSync(fromSrc)) return fromSrc;
  throw new DbAccessError('TUNNEL_FAILED', 'cannot locate watchdog.js (run the build first)');
}


class SsmTunnelHandle implements TunnelHandle {
  readonly localHost = '127.0.0.1';
  private closed = false;

  constructor(
    readonly localPort: number,
    readonly target: string,
    private readonly watchdog: ChildProcess,
    private readonly childPid: number,
    private readonly logger: Logger,
  ) {}

  get externalPids(): number[] {
    const pids = [this.childPid];
    if (this.watchdog.pid !== undefined) pids.unshift(this.watchdog.pid);
    return pids;
  }

  async isHealthy(): Promise<boolean> {
    if (this.closed || this.watchdog.exitCode !== null || this.watchdog.signalCode !== null) return false;
    return tcpProbe(this.localPort);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Closing our end of the stdin pipe triggers the watchdog's kill path even
    // if signals are lost; SIGTERM covers the graceful case.
    try {
      this.watchdog.stdin?.end();
    } catch {
      /* already closed */
    }
    try {
      this.watchdog.kill('SIGTERM');
    } catch {
      /* already dead */
    }
    await new Promise<void>((resolve) => {
      if (this.watchdog.exitCode !== null || this.watchdog.signalCode !== null) return resolve();
      const timer = setTimeout(() => resolve(), 5_000);
      timer.unref();
      this.watchdog.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.logger.info('ssm tunnel closed', { localPort: this.localPort });
  }
}

/**
 * SSM port-forwarding tunnel via `aws ssm start-session`, spawned under the
 * dependency-free watchdog: the watchdog holds our stdin pipe and kills the
 * whole aws/session-manager-plugin tree the moment this process dies — even on
 * SIGKILL, where no signal handler could run.
 */
export class SsmTunnelProvider implements TunnelProvider {
  readonly type = 'ssm';

  private readonly resolver: SsmTargetResolver;

  constructor(
    private readonly logger: Logger,
    private readonly ssoSessions?: SsoSessionManager,
    resolver?: SsmTargetResolver,
  ) {
    this.resolver = resolver ?? new SsmTargetResolver(logger);
  }

  async open(req: TunnelOpenRequest): Promise<TunnelHandle> {
    const options = req.config.options as SsmTunnelOptions;
    const logger = this.logger.child({ tunnel: req.name });

    // SSO bootstrap: verify (and if needed establish) the session BEFORE
    // spawning the tunnel — aws ssm start-session would fail cryptically otherwise.
    const sso = req.config.type === 'ssm' ? req.config.sso : undefined;
    if (sso && this.ssoSessions) {
      await this.ssoSessions.ensureSession({
        session: sso.session,
        profile: sso.profile ?? options.profile,
        timeoutMs: sso.timeout_ms,
      });
    }
    const discover = options.discover;
    if (!discover) {
      return this.openTarget(req, options, options.target!, logger);
    }

    // Which instance to try first:
    // - target + discover: the pinned target, unless an earlier fallback left a
    //   still-valid discovered id in the cache (the pinned one already failed);
    // - discover only: the (cached or freshly) discovered instance.
    const ctx = { region: options.region, profile: options.profile };
    const first = options.target
      ? (this.resolver.peek(req.name, discover, ctx)?.instanceId ?? options.target)
      : (await this.resolver.resolve(req.name, discover, ctx)).instanceId;

    try {
      return await this.openTarget(req, options, first, logger);
    } catch (err) {
      // The bastion may have been recreated: drop the cache, look again and
      // retry once when the lookup points somewhere else.
      this.resolver.invalidate(req.name);
      let fresh;
      try {
        fresh = await this.resolver.resolve(req.name, discover, ctx, { fresh: true });
      } catch (lookupErr) {
        logger.warn('ssm bastion fallback lookup failed', { failedTarget: first, err: lookupErr });
        throw err;
      }
      if (fresh.instanceId === first) throw err;
      logger.warn('ssm tunnel failed on the current bastion; retrying on the discovered instance', {
        failedTarget: first,
        discovered: fresh.instanceId,
        pinnedTarget: options.target,
      });
      return this.openTarget(req, options, fresh.instanceId, logger);
    }
  }

  private async openTarget(
    req: TunnelOpenRequest,
    options: SsmTunnelOptions,
    target: string,
    logger: Logger,
  ): Promise<TunnelHandle> {
    const awsArgs = [
      'ssm',
      'start-session',
      '--target',
      target,
      '--document-name',
      options.document_name ?? DEFAULT_DOCUMENT,
      '--parameters',
      JSON.stringify({
        host: [req.remote.host],
        portNumber: [String(req.remote.port)],
        localPortNumber: [String(req.localPort)],
      }),
      ...(options.region ? ['--region', options.region] : []),
      ...(options.profile ? ['--profile', options.profile] : []),
    ];

    let lastError: DbAccessError | undefined;
    for (const awsCmd of getPlatform().awsCommandCandidates()) {
      try {
        return await this.openWithCommand(req, target, awsCmd, awsArgs, logger);
      } catch (err) {
        lastError = err as DbAccessError;
        if (!/failed to spawn|ENOENT/.test(lastError.message)) throw lastError;
      }
    }
    throw (
      lastError ??
      new DbAccessError('TUNNEL_FAILED', `tunnel "${req.name}": aws CLI not found`, {
        hint: 'Install the AWS CLI and the session-manager-plugin, and make sure they are on PATH.',
      })
    );
  }

  private async openWithCommand(
    req: TunnelOpenRequest,
    target: string,
    awsCmd: string,
    awsArgs: string[],
    logger: Logger,
  ): Promise<TunnelHandle> {
    const watchdogPath = resolveWatchdogPath();
    const watchdog = spawn(process.execPath, [watchdogPath, '--', awsCmd, ...awsArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Keep a stderr tail for diagnostics; forward everything to our stderr.
    let stderrTail = '';
    watchdog.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4_096);
      process.stderr.write(chunk);
    });

    const fail = async (message: string): Promise<never> => {
      try {
        watchdog.stdin.end();
        watchdog.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      throw new DbAccessError('TUNNEL_FAILED', `tunnel "${req.name}": ${message}`, {
        hint: stderrTail.trim() !== '' ? `tunnel process output: ${stderrTail.trim().slice(-500)}` : undefined,
      });
    };

    const childPid = await this.readChildPid(watchdog).catch((err: Error) => fail(err.message));

    const ready = await waitForTcp(req.localPort, {
      deadlineMs: 20_000,
      aborted: () => watchdog.exitCode !== null,
    });
    if (!ready) {
      return fail(
        watchdog.exitCode !== null
          ? `tunnel process exited before the port became ready (exit code ${watchdog.exitCode})`
          : `port 127.0.0.1:${req.localPort} did not become ready within 20s`,
      );
    }

    logger.info('ssm tunnel opened', {
      localPort: req.localPort,
      remote: `${req.remote.host}:${req.remote.port}`,
      target,
      watchdogPid: watchdog.pid,
      childPid,
    });
    return new SsmTunnelHandle(req.localPort, target, watchdog, childPid, logger);
  }

  /** First stdout line of the watchdog is {"childPid": N}. */
  private readChildPid(watchdog: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('watchdog did not report the child pid within 10s')), 10_000);
      timer.unref();
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        cleanup();
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as { childPid?: number };
          if (typeof parsed.childPid !== 'number') throw new Error('missing childPid');
          resolve(parsed.childPid);
        } catch {
          reject(new Error(`unexpected watchdog output: ${buffer.slice(0, 200)}`));
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`failed to spawn tunnel process (watchdog exit code ${code})`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        watchdog.stdout?.off('data', onData);
        watchdog.off('exit', onExit);
      };
      watchdog.stdout?.on('data', onData);
      watchdog.once('exit', onExit);
    });
  }
}
