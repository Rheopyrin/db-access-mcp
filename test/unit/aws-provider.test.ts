import { afterEach, describe, expect, it } from 'vitest';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { AwsProfileResolver } from '../../src/secrets/aws-profile';
import { AwsSecretsManagerProvider } from '../../src/secrets/aws.provider';
import { StderrLogger } from '../../src/logging/logger';
import type { SsoSessionManager } from '../../src/tunnels/sso-session';

const logger = new StderrLogger('silent');

function resolverWith(profiles: Record<string, unknown> = {}) {
  const ssoCalls: { session?: string; profile?: string; timeoutMs: number }[] = [];
  const ssoSessions = {
    ensureSession: async (req: { session?: string; profile?: string; timeoutMs: number }) => {
      ssoCalls.push(req);
    },
  } as unknown as SsoSessionManager;
  const configService = new ConfigService(parseConfig({ aws_secret_profiles: profiles }));
  return { resolver: new AwsProfileResolver(configService, ssoSessions), ssoCalls };
}

function providerWith(
  send: (cmd: { input: Record<string, unknown> }) => Promise<Record<string, unknown>>,
  profiles: Record<string, unknown> = {},
) {
  const { resolver, ssoCalls } = resolverWith(profiles);
  const clientsCreated: { region?: string; profile?: string }[] = [];
  const provider = new AwsSecretsManagerProvider(resolver, logger, (region, profile) => {
    clientsCreated.push({ region, profile });
    return { send: send as never };
  });
  return { provider, clientsCreated, ssoCalls };
}

const ok = async () => ({ SecretString: '{"username":"u","password":"p"}' });

afterEach(() => {
  delete process.env['AWS_TEST_PROFILE'];
  delete process.env['AWS_TEST_REGION'];
});

describe('AwsSecretsManagerProvider', () => {
  it('uses the referenced profile: region/profile for the client, reload interval as ttl', async () => {
    const { provider, clientsCreated } = providerWith(ok, {
      prod: { aws_profile: 'prod-profile', aws_region: 'us-east-1', reload_interval_ms: 60_000 },
    });
    const secret = await provider.resolve({ secret_id: 'prod/db', target: 'prod' }, 'db1');
    expect(secret.data).toEqual({ username: 'u', password: 'p' });
    expect(secret.ttlMs).toBe(60_000);
    expect(clientsCreated).toEqual([{ region: 'us-east-1', profile: 'prod-profile' }]);
  });

  it('resolves env-ref profile fields lazily', async () => {
    process.env['AWS_TEST_PROFILE'] = 'env-profile';
    process.env['AWS_TEST_REGION'] = 'eu-west-1';
    const { provider, clientsCreated } = providerWith(ok, {
      dev: { aws_profile: { env: 'AWS_TEST_PROFILE' }, aws_region: { env: 'AWS_TEST_REGION' } },
    });
    const secret = await provider.resolve({ secret_id: 's', target: 'dev' }, 'db1');
    expect(clientsCreated).toEqual([{ region: 'eu-west-1', profile: 'env-profile' }]);
    expect(secret.ttlMs).toBeUndefined();
  });

  it('fails when an env-ref in the profile is missing', async () => {
    const { provider } = providerWith(ok, { dev: { aws_profile: { env: 'AWS_MISSING_PROFILE' } } });
    await expect(provider.resolve({ secret_id: 's', target: 'dev' }, 'db1')).rejects.toThrow(/AWS_MISSING_PROFILE/);
  });

  it('without target uses the default credential chain and is static', async () => {
    const { provider, clientsCreated } = providerWith(ok);
    const secret = await provider.resolve({ secret_id: 'plain' }, 'db1');
    expect(clientsCreated).toEqual([{ region: undefined, profile: undefined }]);
    expect(secret.ttlMs).toBeUndefined();
  });

  it('caches clients per profile and reuses the default client', async () => {
    const { provider, clientsCreated } = providerWith(ok, { p1: { aws_region: 'us-east-1' } });
    await provider.resolve({ secret_id: 'a', target: 'p1' }, 'db1');
    await provider.resolve({ secret_id: 'b', target: 'p1' }, 'db2');
    await provider.resolve({ secret_id: 'c' }, 'db3');
    await provider.resolve({ secret_id: 'd' }, 'db4');
    expect(clientsCreated).toHaveLength(2);
  });

  it('passes secret_id and version_stage to the API', async () => {
    let input: Record<string, unknown> | undefined;
    const { provider } = providerWith(async (cmd) => {
      input = cmd.input;
      return { SecretString: '{}' };
    });
    await provider.resolve({ secret_id: 'arn:aws:secretsmanager:...', version_stage: 'AWSPENDING' }, 'db1');
    expect(input).toMatchObject({ SecretId: 'arn:aws:secretsmanager:...', VersionStage: 'AWSPENDING' });
  });

  it('rejects non-JSON-object secrets with a helpful hint', async () => {
    const { provider } = providerWith(async () => ({ SecretString: 'just-a-string' }));
    await expect(provider.resolve({ secret_id: 's' }, 'db1')).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
      hint: expect.stringContaining('JSON object'),
    });
  });

  it('rejects binary-only secrets', async () => {
    const { provider } = providerWith(async () => ({ SecretBinary: new Uint8Array([1]) }));
    await expect(provider.resolve({ secret_id: 's' }, 'db1')).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
      message: expect.stringContaining('SecretString'),
    });
  });

  it('wraps API failures into SECRET_RESOLUTION_FAILED', async () => {
    const { provider } = providerWith(async () => {
      throw new Error('AccessDeniedException');
    });
    await expect(provider.resolve({ secret_id: 's' }, 'db1')).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
      message: expect.stringContaining('AccessDeniedException'),
    });
  });

  it('rejects an invalid spec (including legacy inline region/profile fields)', async () => {
    const { provider } = providerWith(ok);
    await expect(provider.resolve({ wrong: true }, 'db1')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(provider.resolve({ secret_id: 's', region: 'us-east-1' }, 'db1')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});

describe('AwsProfileResolver SSO bootstrap', () => {
  it('runs ensureSession on EVERY resolve when the profile declares sso, with aws_profile as fallback', async () => {
    const { resolver, ssoCalls } = resolverWith({
      prod: { aws_profile: 'prod-profile', aws_region: 'us-east-1', sso: { session: 'drew' } },
    });
    await resolver.resolve('prod');
    await resolver.resolve('prod');
    expect(ssoCalls).toEqual([
      { session: 'drew', profile: 'prod-profile', timeoutMs: 300_000 },
      { session: 'drew', profile: 'prod-profile', timeoutMs: 300_000 },
    ]);
  });

  it('sso.profile overrides aws_profile for the login', async () => {
    const { resolver, ssoCalls } = resolverWith({
      prod: { aws_profile: 'work-profile', sso: { profile: 'login-profile', timeout_ms: 60_000 } },
    });
    await resolver.resolve('prod');
    expect(ssoCalls).toEqual([{ session: undefined, profile: 'login-profile', timeoutMs: 60_000 }]);
  });

  it('does not touch SSO without an sso block or without a target', async () => {
    const { resolver, ssoCalls } = resolverWith({ plain: { aws_region: 'us-east-1' } });
    expect(await resolver.resolve('plain')).toEqual({
      profile: undefined,
      region: 'us-east-1',
      reloadIntervalMs: undefined,
    });
    expect(await resolver.resolve(undefined)).toEqual({});
    expect(ssoCalls).toEqual([]);
  });

  it('the aws provider consumes sso bootstrap through the resolver', async () => {
    const { provider, ssoCalls } = providerWith(ok, {
      prod: { aws_profile: 'p', sso: { session: 'NcLabs' } },
    });
    await provider.resolve({ secret_id: 's', target: 'prod' }, 'db1');
    expect(ssoCalls).toEqual([{ session: 'NcLabs', profile: 'p', timeoutMs: 300_000 }]);
  });

  it('ensureSession failures propagate to the caller', async () => {
    const configService = new ConfigService(
      parseConfig({ aws_secret_profiles: { prod: { aws_profile: 'p', sso: {} } } }),
    );
    const failing = {
      ensureSession: async () => {
        throw new Error('sso timeout (test)');
      },
    } as unknown as SsoSessionManager;
    const resolver = new AwsProfileResolver(configService, failing);
    await expect(resolver.resolve('prod')).rejects.toThrow('sso timeout (test)');
  });
});
