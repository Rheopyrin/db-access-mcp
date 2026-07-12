import { describe, expect, it } from 'vitest';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { DbAccessError } from '../../src/errors';

function baseConfig(): Record<string, unknown> {
  return {
    tunnels: {
      t1: { type: 'ssm', options: { target: 'i-abc', region: 'us-east-1' } },
      t2: { type: 'ssh', options: { host: 'bastion', username: 'user', privateKey: '~/.ssh/id' } },
    },
    connections: {
      db1: {
        type: 'postgres',
        description: 'main',
        read_only: true,
        metadata: { team: 'growth', prod: true },
        options: { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' },
      },
    },
  };
}

describe('parseConfig', () => {
  it('parses a valid config and applies defaults', () => {
    const config = parseConfig(baseConfig());
    expect(config.connections['db1']?.read_only).toBe(true);
    expect(config.pool).toEqual({});
    expect(config.limits).toEqual({});
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseConfig({ ...baseConfig(), unknown_key: 1 })).toThrow(DbAccessError);
  });

  it('rejects unknown connection keys (typo protection)', () => {
    const cfg = baseConfig();
    (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!['readonly'] = true;
    expect(() => parseConfig(cfg)).toThrow(/readonly|unrecognized/i);
  });

  it('rejects a connection with an unknown tunnel target', () => {
    const cfg = baseConfig();
    (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!['tunnel'] = { target: 'nope' };
    expect(() => parseConfig(cfg)).toThrow(/tunnel target "nope"/);
  });

  it('rejects more than one secret provider per connection', () => {
    const cfg = baseConfig();
    (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!['secrets'] = {
      env: { a: 'A' },
      vault: { path: 'x' },
    };
    expect(() => parseConfig(cfg)).toThrow(/exactly one secret provider/);
  });

  it('rejects placeholders without a configured secrets provider', () => {
    const cfg = baseConfig();
    (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!['options'] = {
      host: 'h',
      database: 'd',
      password: '${env.password}',
    };
    expect(() => parseConfig(cfg)).toThrow(/no "secrets" provider/);
  });

  it('rejects placeholder namespace not matching the configured provider', () => {
    const cfg = baseConfig();
    const db1 = (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!;
    db1['options'] = { host: 'h', database: 'd', password: '${vault.password}' };
    db1['secrets'] = { env: { password: 'PW' } };
    expect(() => parseConfig(cfg)).toThrow(/namespace "vault".*provider is "env"/);
  });

  it('accepts placeholders matching the configured provider, including nested paths', () => {
    const cfg = baseConfig();
    const db1 = (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!;
    db1['options'] = { host: 'h', database: 'd', user: '${vault.data.user}', password: '${vault.data.password}' };
    db1['secrets'] = { vault: { path: 'secret/data/db' } };
    expect(() => parseConfig(cfg)).not.toThrow();
  });

  it('rejects invalid ssm tunnel options', () => {
    const cfg = baseConfig();
    (cfg['tunnels'] as Record<string, unknown>)['t1'] = { type: 'ssm', options: {} };
    expect(() => parseConfig(cfg)).toThrow(DbAccessError);
  });
});

describe('ConfigService', () => {
  it('merges limits: defaults <- global <- per-connection', () => {
    const cfg = baseConfig();
    cfg['limits'] = { max_rows: 500 };
    const db1 = (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!;
    db1['limits'] = { query_timeout_ms: 5000 };
    const service = new ConfigService(parseConfig(cfg));
    expect(service.effectiveLimits('db1')).toEqual({
      max_rows: 500,
      query_timeout_ms: 5000,
      idle_close_ms: 600_000,
    });
  });

  it('merges pool settings: defaults <- global <- per-connection', () => {
    const cfg = baseConfig();
    cfg['pool'] = { max: 10 };
    const db1 = (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!;
    db1['pool'] = { min: 2 };
    const service = new ConfigService(parseConfig(cfg));
    expect(service.effectivePool('db1')).toEqual({
      max: 10,
      min: 2,
      idle_timeout_ms: 30_000,
      connection_timeout_ms: 10_000,
    });
  });

  it('throws CONNECTION_NOT_FOUND for unknown keys', () => {
    const service = new ConfigService(parseConfig(baseConfig()));
    expect(() => service.getConnection('nope')).toThrow(
      expect.objectContaining({ code: 'CONNECTION_NOT_FOUND' }),
    );
  });

  it('returns the secret spec of the single configured provider', () => {
    const cfg = baseConfig();
    const db1 = (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!;
    db1['options'] = { host: 'h', database: 'd', password: '${env.pw}' };
    db1['secrets'] = { env: { pw: 'PW_VAR' } };
    const service = new ConfigService(parseConfig(cfg));
    expect(service.secretSpec('db1')).toEqual({ provider: 'env', spec: { pw: 'PW_VAR' } });
  });
});

describe('config v2: named vaults, aws profiles, env_files', () => {
  it('accepts named vaults with string and env-ref values', () => {
    const cfg = baseConfig();
    cfg['vault'] = {
      'vault-main': { address: 'https://v:8200', token: 't' },
      'vault-dr': { address: { env: 'DR_ADDR' }, token: { env: 'DR_TOKEN' } },
    };
    const service = new ConfigService(parseConfig(cfg));
    expect(Object.keys(service.vaultConfigs)).toEqual(['vault-main', 'vault-dr']);
    expect(service.getVaultConfig('vault-dr').address).toEqual({ env: 'DR_ADDR' });
    expect(() => service.getVaultConfig('nope')).toThrow(/vault "nope"/);
  });

  it('accepts aws_secret_profiles with env-ref values and reload interval', () => {
    const cfg = baseConfig();
    cfg['aws_secret_profiles'] = {
      prod: { aws_profile: 'p', aws_region: 'us-east-1', reload_interval_ms: 60_000 },
      dev: { aws_profile: { env: 'DEV_PROFILE' } },
    };
    const service = new ConfigService(parseConfig(cfg));
    expect(service.getAwsSecretProfile('prod').reload_interval_ms).toBe(60_000);
    expect(() => service.getAwsSecretProfile('nope')).toThrow(/aws secret profile "nope"/);
  });

  it('rejects a vault secret target that is not defined', () => {
    const cfg = baseConfig();
    const db1 = (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!;
    db1['options'] = { host: 'h', database: 'd', password: '${vault.pw}' };
    db1['secrets'] = { vault: { target: 'ghost', path: 'p' } };
    expect(() => parseConfig(cfg)).toThrow(/secrets\.vault\.target "ghost"/);
  });

  it('rejects an aws secret target that is not defined', () => {
    const cfg = baseConfig();
    const db1 = (cfg['connections'] as Record<string, Record<string, unknown>>)['db1']!;
    db1['options'] = { host: 'h', database: 'd', password: '${aws.pw}' };
    db1['secrets'] = { aws: { secret_id: 's', target: 'ghost' } };
    expect(() => parseConfig(cfg)).toThrow(/secrets\.aws\.target "ghost"/);
  });

  it('accepts targets that exist and target-less specs (implicit defaults)', () => {
    const cfg = baseConfig();
    cfg['vault'] = { v1: { address: 'a' } };
    cfg['aws_secret_profiles'] = { p1: {} };
    const conns = cfg['connections'] as Record<string, Record<string, unknown>>;
    conns['db1']!['options'] = { host: 'h', database: 'd', password: '${vault.pw}' };
    conns['db1']!['secrets'] = { vault: { target: 'v1', path: 'p' } };
    conns['db2'] = {
      type: 'postgres',
      options: { host: 'h', database: 'd', password: '${aws.pw}' },
      secrets: { aws: { secret_id: 's' } },
    };
    expect(() => parseConfig(cfg)).not.toThrow();
  });

  it('parses env_files as a string list', () => {
    const cfg = baseConfig();
    cfg['env_files'] = ['~/.db_acess_mcp/a.env', '/abs/b.env'];
    const service = new ConfigService(parseConfig(cfg));
    expect(service.envFiles).toHaveLength(2);
  });

  it('a user-defined vault named "default" is a regular named entry', () => {
    const cfg = baseConfig();
    cfg['vault'] = { default: { address: 'https://user-default:8200' } };
    const service = new ConfigService(parseConfig(cfg));
    expect(service.getVaultConfig('default').address).toBe('https://user-default:8200');
  });
});
