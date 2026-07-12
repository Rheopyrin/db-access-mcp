import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { expandTilde } from '../config/paths';
import { DbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';
import type { TunnelHandle, TunnelOpenRequest, TunnelProvider } from '../interfaces/tunnel-provider';
import { getPlatform } from '../platform/platform';

interface SshOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  agent?: boolean | string;
  ready_timeout_ms?: number;
  host_key_sha256?: string;
  known_hosts?: string;
  strict_host_key?: boolean;
}

/** SHA-256 fingerprint of a host key blob, base64 without padding (ssh-keygen style). */
export function sha256Fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** The known_hosts name form: bare host for port 22, `[host]:port` otherwise. */
function knownHostsName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function hostMatchesPatterns(patterns: string, host: string, port: number): boolean {
  const name = knownHostsName(host, port);
  for (const pattern of patterns.split(',')) {
    if (pattern.startsWith('|1|')) {
      // Hashed entry: |1|<base64 salt>|<base64 HMAC-SHA1(salt, name)>.
      const seg = pattern.split('|');
      if (seg.length < 4 || !seg[2] || !seg[3]) continue;
      const digest = createHmac('sha1', Buffer.from(seg[2], 'base64')).update(name).digest('base64');
      if (digest === seg[3]) return true;
    } else if (pattern === name) {
      return true;
    }
  }
  return false;
}

/**
 * Verdict of matching a host key against a known_hosts file:
 * - 'match'    a line for this host carries exactly this key;
 * - 'mismatch' a line for this host exists but the key differs (or is @revoked);
 * - 'absent'   no line references this host at all.
 */
export function knownHostsVerdict(
  content: string,
  host: string,
  port: number,
  key: Buffer,
): 'match' | 'mismatch' | 'absent' {
  const keyB64 = key.toString('base64');
  let sawHost = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    let rest = line;
    let revoked = false;
    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      if (sp === -1) continue;
      revoked = rest.slice(0, sp) === '@revoked';
      rest = rest.slice(sp + 1).trim();
    }
    const parts = rest.split(/\s+/);
    if (parts.length < 3 || !parts[0] || !parts[2]) continue;
    if (!hostMatchesPatterns(parts[0], host, port)) continue;
    sawHost = true;
    if (parts[2] === keyB64) return revoked ? 'mismatch' : 'match';
  }
  return sawHost ? 'mismatch' : 'absent';
}

class SshTunnelHandle implements TunnelHandle {
  readonly localHost = '127.0.0.1';
  readonly externalPids: number[] = []; // in-process: dies with the MCP process, no orphan risk
  private healthy = true;

  constructor(
    readonly localPort: number,
    private readonly client: ssh2.Client,
    private readonly server: net.Server,
    private readonly logger: Logger,
  ) {
    client.on('close', () => {
      this.healthy = false;
    });
    client.on('error', (err) => {
      this.healthy = false;
      this.logger.warn('ssh tunnel client error', { err });
    });
  }

  async isHealthy(): Promise<boolean> {
    return this.healthy && this.server.listening;
  }

  async close(): Promise<void> {
    this.healthy = false;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.client.end();
  }
}

/**
 * In-process SSH tunnel: a local TCP listener forwards every connection over
 * an ssh2 channel. Being in-process, it terminates with the MCP process even
 * on SIGKILL — no orphaned ports or processes are possible.
 */
export class SshTunnelProvider implements TunnelProvider {
  readonly type = 'ssh';

  constructor(private readonly logger: Logger) {}

  async open(req: TunnelOpenRequest): Promise<TunnelHandle> {
    const options = req.config.options as SshOptions;
    const logger = this.logger.child({ tunnel: req.name });

    const connectConfig: ssh2.ConnectConfig = {
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      passphrase: options.passphrase,
      readyTimeout: options.ready_timeout_ms ?? 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      // Reject unknown/altered host keys (MITM defence); see verifyHostKey.
      hostVerifier: (key: Buffer) => this.verifyHostKey(options, req.name, key, logger),
    };
    if (options.privateKey) {
      const keyPath = expandTilde(options.privateKey);
      try {
        connectConfig.privateKey = fs.readFileSync(keyPath);
      } catch (err) {
        throw new DbAccessError('TUNNEL_FAILED', `tunnel "${req.name}": cannot read private key ${keyPath}`, {
          cause: err,
        });
      }
    }
    if (options.agent !== undefined && options.agent !== false) {
      connectConfig.agent = options.agent === true ? getPlatform().defaultSshAgent() : options.agent;
    }

    const client = new ssh2.Client();
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', (err) =>
        reject(
          new DbAccessError('TUNNEL_FAILED', `tunnel "${req.name}": ssh connection failed: ${err.message}`, {
            cause: err,
          }),
        ),
      );
      client.connect(connectConfig);
    });

    const server = net.createServer((socket) => {
      client.forwardOut(
        socket.localAddress ?? '127.0.0.1',
        socket.localPort ?? 0,
        req.remote.host,
        req.remote.port,
        (err, stream) => {
          if (err) {
            logger.warn('ssh forwardOut failed', { err });
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        },
      );
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', (err) => {
        client.end();
        reject(new DbAccessError('TUNNEL_FAILED', `tunnel "${req.name}": cannot listen on 127.0.0.1:${req.localPort}: ${err.message}`, { cause: err }));
      });
      server.listen(req.localPort, '127.0.0.1', () => resolve());
    });

    logger.info('ssh tunnel opened', {
      localPort: req.localPort,
      remote: `${req.remote.host}:${req.remote.port}`,
      via: `${options.host}:${options.port}`,
    });
    return new SshTunnelHandle(req.localPort, client, server, logger);
  }

  /**
   * Returns true only when the bastion's host key is trusted. Precedence:
   * explicit opt-out (strict_host_key:false) -> pinned SHA-256 fingerprint ->
   * known_hosts file (default ~/.ssh/known_hosts). Fails CLOSED: an unknown or
   * unverifiable key is rejected rather than blindly accepted.
   */
  private verifyHostKey(options: SshOptions, name: string, key: Buffer, logger: Logger): boolean {
    if (options.strict_host_key === false) return true;

    if (options.host_key_sha256) {
      const want = options.host_key_sha256.replace(/^SHA256:/i, '').replace(/=+$/, '');
      const got = sha256Fingerprint(key);
      if (got === want) return true;
      logger.warn('ssh host key fingerprint mismatch — rejecting', { tunnel: name, expected: want, got });
      return false;
    }

    const file = expandTilde(options.known_hosts ?? path.join(os.homedir(), '.ssh', 'known_hosts'));
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      logger.warn('ssh host key cannot be verified (no known_hosts and no host_key_sha256 pin) — rejecting', {
        tunnel: name,
        file,
        hint: 'Add a "host_key_sha256" pin, point "known_hosts" at a file, or set "strict_host_key": false to opt out.',
      });
      return false;
    }
    const verdict = knownHostsVerdict(content, options.host, options.port, key);
    if (verdict === 'match') return true;
    logger.warn(`ssh host key ${verdict} against known_hosts — rejecting`, {
      tunnel: name,
      host: options.host,
      port: options.port,
      fingerprint: sha256Fingerprint(key),
      file,
    });
    return false;
  }
}
