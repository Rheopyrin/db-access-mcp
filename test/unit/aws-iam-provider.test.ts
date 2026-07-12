import { describe, expect, it } from 'vitest';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { AwsIamSecretProvider, type SignerLike } from '../../src/secrets/aws-iam.provider';
import { AwsProfileResolver } from '../../src/secrets/aws-profile';
import { renderOptions } from '../../src/secrets/renderer';
import { StderrLogger } from '../../src/logging/logger';
import type { SsoSessionManager } from '../../src/tunnels/sso-session';

const logger = new StderrLogger('silent');

function setup(opts: {
  connectionOptions?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  token?: string;
  failSigner?: boolean;
} = {}) {
  const configService = new ConfigService(
    parseConfig({
      aws_secret_profiles: opts.profiles ?? { prod: { aws_profile: 'p', aws_region: 'us-east-1', sso: { session: 'drew' } } },
      connections: {
        db1: {
          type: 'postgres',
          options: opts.connectionOptions ?? {
            host: 'pg.rds.amazonaws.com',
            port: 5432,
            database: 'appdb',
            user: '${aws_iam.username}',
            password: '${aws_iam.token}',
          },
          secrets: { aws_iam: { username: 'readonly', target: 'prod' } },
        },
      },
    }),
  );
  const ssoCalls: unknown[] = [];
  const ssoSessions = {
    ensureSession: async (req: unknown) => {
      ssoCalls.push(req);
    },
  } as unknown as SsoSessionManager;
  const signerArgs: Record<string, unknown>[] = [];
  const provider = new AwsIamSecretProvider(
    configService,
    new AwsProfileResolver(configService, ssoSessions),
    logger,
    (args): SignerLike => {
      signerArgs.push(args);
      return {
        getAuthToken: async () => {
          if (opts.failSigner) throw new Error('AccessDenied (test)');
          return opts.token ?? 'signed-token';
        },
      };
    },
  );
  return { provider, signerArgs, ssoCalls, configService };
}

describe('AwsIamSecretProvider', () => {
  it('signs a token for the REAL RDS host/port with profile region and runs SSO bootstrap first', async () => {
    const { provider, signerArgs, ssoCalls } = setup();
    const secret = await provider.resolve({ username: 'readonly', target: 'prod' }, 'db1');
    expect(secret.data).toEqual({ username: 'readonly', token: 'signed-token' });
    expect(secret.ttlMs).toBe(900_000);
    expect(signerArgs).toEqual([
      { hostname: 'pg.rds.amazonaws.com', port: 5432, username: 'readonly', region: 'us-east-1', profile: 'p' },
    ]);
    expect(ssoCalls).toEqual([{ session: 'drew', profile: 'p', timeoutMs: 300_000 }]);
  });

  it('renders the token into placeholders', async () => {
    const { provider, configService } = setup({ token: 'tok-123' });
    const secret = await provider.resolve({ username: 'readonly', target: 'prod' }, 'db1');
    const rendered = renderOptions(configService.getConnection('db1').options, 'aws_iam', secret.data, 'db1');
    expect(rendered['user']).toBe('readonly');
    expect(rendered['password']).toBe('tok-123');
  });

  it('spec host/port override the connection options', async () => {
    const { provider, signerArgs } = setup();
    await provider.resolve({ username: 'readonly', target: 'prod', host: 'replica.rds', port: 5433 }, 'db1');
    expect(signerArgs[0]).toMatchObject({ hostname: 'replica.rds', port: 5433 });
  });

  it('caches the signer per target+endpoint+username', async () => {
    const { provider, signerArgs } = setup();
    await provider.resolve({ username: 'readonly', target: 'prod' }, 'db1');
    await provider.resolve({ username: 'readonly', target: 'prod' }, 'db1');
    expect(signerArgs).toHaveLength(1);
  });

  it('fails with CONFIG_INVALID when host/port cannot be determined', async () => {
    const { provider } = setup({
      connectionOptions: { connectionString: 'postgres://u:p@h:5432/db' },
    });
    await expect(provider.resolve({ username: 'readonly', target: 'prod' }, 'db1')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      hint: expect.stringContaining('host:port'),
    });
  });

  it('wraps signer failures into SECRET_RESOLUTION_FAILED with the rds-db:connect hint', async () => {
    const { provider } = setup({ failSigner: true });
    await expect(provider.resolve({ username: 'readonly', target: 'prod' }, 'db1')).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
      hint: expect.stringContaining('rds-db:connect'),
    });
  });

  it('rejects an invalid spec', async () => {
    const { provider } = setup();
    await expect(provider.resolve({ target: 'prod' }, 'db1')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('unknown aws_iam target fails at config load', () => {
    expect(() =>
      parseConfig({
        connections: {
          db1: {
            type: 'postgres',
            options: { host: 'h', port: 5432, database: 'd', password: '${aws_iam.token}' },
            secrets: { aws_iam: { username: 'u', target: 'ghost' } },
          },
        },
      }),
    ).toThrow(/secrets\.aws_iam\.target "ghost"/);
  });
});
