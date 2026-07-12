import { describe, expect, it } from 'vitest';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { AwsProfileResolver } from '../../src/secrets/aws-profile';
import { AwsRedshiftCredsProvider } from '../../src/secrets/aws-redshift-creds.provider';
import { StderrLogger } from '../../src/logging/logger';
import type { SsoSessionManager } from '../../src/tunnels/sso-session';

const logger = new StderrLogger('silent');

function setup(send: (cmd: { input: Record<string, unknown> }) => Promise<Record<string, unknown>>) {
  const configService = new ConfigService(
    parseConfig({ aws_secret_profiles: { prod: { aws_profile: 'p', aws_region: 'us-east-1', sso: { session: 'NcLabs' } } } }),
  );
  const ssoCalls: unknown[] = [];
  const ssoSessions = {
    ensureSession: async (req: unknown) => {
      ssoCalls.push(req);
    },
  } as unknown as SsoSessionManager;
  const clientsCreated: { region?: string; profile?: string }[] = [];
  const provider = new AwsRedshiftCredsProvider(
    new AwsProfileResolver(configService, ssoSessions),
    logger,
    (region, profile) => {
      clientsCreated.push({ region, profile });
      return { send: send as never };
    },
  );
  return { provider, clientsCreated, ssoCalls };
}

const okCreds = async () => ({
  DbUser: 'IAM:readonly',
  DbPassword: 'temp-pass',
  Expiration: new Date(Date.now() + 3_600_000),
});

describe('AwsRedshiftCredsProvider', () => {
  it('issues temporary credentials keeping the IAM: prefix, with ttl from Expiration', async () => {
    const { provider, ssoCalls } = setup(okCreds);
    const secret = await provider.resolve({ cluster_id: 'rtb', db_user: 'readonly', target: 'prod' }, 'dwh');
    expect(secret.data).toEqual({ username: 'IAM:readonly', password: 'temp-pass' });
    expect(secret.ttlMs).toBeGreaterThan(3_500_000);
    expect(secret.ttlMs).toBeLessThanOrEqual(3_600_000);
    expect(ssoCalls).toEqual([{ session: 'NcLabs', profile: 'p', timeoutMs: 300_000 }]);
  });

  it('passes cluster, user and duration to the API and caches the client per target', async () => {
    let input: Record<string, unknown> | undefined;
    const { provider, clientsCreated } = setup(async (cmd) => {
      input = cmd.input;
      return okCreds();
    });
    await provider.resolve({ cluster_id: 'rtb', db_user: 'readonly', target: 'prod', duration_seconds: 900 }, 'dwh');
    await provider.resolve({ cluster_id: 'rtb', db_user: 'readonly', target: 'prod' }, 'dwh');
    expect(input).toMatchObject({ ClusterIdentifier: 'rtb', DbUser: 'readonly', DurationSeconds: 3_600 });
    expect(clientsCreated).toEqual([{ region: 'us-east-1', profile: 'p' }]);
  });

  it('falls back to duration_seconds when the API returns no Expiration', async () => {
    const { provider } = setup(async () => ({ DbUser: 'IAM:r', DbPassword: 'x' }));
    const secret = await provider.resolve({ cluster_id: 'c', db_user: 'r', target: 'prod', duration_seconds: 900 }, 'dwh');
    expect(secret.ttlMs).toBe(900_000);
  });

  it('wraps API failures into SECRET_RESOLUTION_FAILED with the policy hint', async () => {
    const { provider } = setup(async () => {
      throw new Error('AccessDenied (test)');
    });
    await expect(provider.resolve({ cluster_id: 'c', db_user: 'r', target: 'prod' }, 'dwh')).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
      hint: expect.stringContaining('GetClusterCredentials'),
    });
  });

  it('rejects invalid specs and out-of-range durations', async () => {
    const { provider } = setup(okCreds);
    await expect(provider.resolve({ cluster_id: 'c' }, 'dwh')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      provider.resolve({ cluster_id: 'c', db_user: 'r', duration_seconds: 100 }, 'dwh'),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('unknown target fails at config load', () => {
    expect(() =>
      parseConfig({
        connections: {
          dwh: {
            type: 'redshift',
            options: { host: 'h', port: 5439, database: 'd', user: '${aws_redshift_creds.username}', password: '${aws_redshift_creds.password}' },
            secrets: { aws_redshift_creds: { cluster_id: 'c', db_user: 'r', target: 'ghost' } },
          },
        },
      }),
    ).toThrow(/secrets\.aws_redshift_creds\.target "ghost"/);
  });
});
