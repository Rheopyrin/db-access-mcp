import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config.service';
import { StderrLogger } from '../../src/logging/logger';
import { SsmTunnelProvider } from '../../src/tunnels/ssm.provider';
import type { SsoSessionManager } from '../../src/tunnels/sso-session';
import { DbAccessError } from '../../src/errors';

const logger = new StderrLogger('silent');

function tunnelConfig(withSso: boolean) {
  const config = parseConfig({
    tunnels: {
      t1: {
        type: 'ssm',
        options: { target: 'i-1', region: 'us-east-1', profile: 'infra' },
        ...(withSso ? { sso: { session: 'drew', profile: 'sso-prod', timeout_ms: 60_000 } } : {}),
      },
    },
  });
  return config.tunnels['t1']!;
}

describe('SsmTunnelProvider + SSO', () => {
  it('ensures the SSO session BEFORE any tunnel spawn and propagates its failure', async () => {
    const calls: { session?: string; profile?: string; timeoutMs: number }[] = [];
    const sso = {
      ensureSession: async (req: { session?: string; profile?: string; timeoutMs: number }) => {
        calls.push(req);
        throw new DbAccessError('TUNNEL_FAILED', 'sso login timed out (test)');
      },
    } as unknown as SsoSessionManager;

    const provider = new SsmTunnelProvider(logger, sso);
    await expect(
      provider.open({ name: 't1', config: tunnelConfig(true), remote: { host: 'db', port: 5432 }, localPort: 20_001 }),
    ).rejects.toMatchObject({ code: 'TUNNEL_FAILED', message: expect.stringContaining('sso login timed out') });

    // The sso block's session/profile win over the tunnel's aws profile.
    expect(calls).toEqual([{ session: 'drew', profile: 'sso-prod', timeoutMs: 60_000 }]);
  });

  it('falls back to the tunnel aws profile when sso.profile is omitted', async () => {
    const calls: { profile?: string }[] = [];
    const sso = {
      ensureSession: async (req: { profile?: string }) => {
        calls.push(req);
        throw new DbAccessError('TUNNEL_FAILED', 'stop here (test)');
      },
    } as unknown as SsoSessionManager;

    const config = parseConfig({
      tunnels: { t1: { type: 'ssm', options: { target: 'i-1', profile: 'infra' }, sso: {} } },
    }).tunnels['t1']!;
    const provider = new SsmTunnelProvider(logger, sso);
    await expect(
      provider.open({ name: 't1', config, remote: { host: 'db', port: 5432 }, localPort: 20_002 }),
    ).rejects.toThrow();
    expect(calls[0]?.profile).toBe('infra');
  });

  it('does not touch SSO for tunnels without an sso block', async () => {
    let called = false;
    const sso = {
      ensureSession: async () => {
        called = true;
      },
    } as unknown as SsoSessionManager;

    const provider = new SsmTunnelProvider(logger, sso);
    // Without sso the provider goes straight to spawning; in tests the aws CLI
    // interaction fails — we only assert that SSO was never consulted.
    await provider
      .open({ name: 't1', config: tunnelConfig(false), remote: { host: 'db', port: 5432 }, localPort: 20_003 })
      .catch(() => undefined);
    expect(called).toBe(false);
  });
});
