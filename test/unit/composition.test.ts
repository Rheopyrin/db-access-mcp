import { describe, expect, it } from 'vitest';
import { buildContainer } from '../../src/composition/container';
import { KeyedRegistry, type SecretProviderRegistry } from '../../src/composition/registries';
import { TYPES } from '../../src/composition/types';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { type SecretsManager } from '../../src/secrets/secrets-manager';
import { StderrLogger } from '../../src/logging/logger';

function makeContainer() {
  const configService = new ConfigService(
    parseConfig({
      connections: {
        db1: {
          type: 'postgres',
          options: { host: 'h', database: 'd', user: '${env.user}', password: '${env.password}' },
          secrets: { env: { user: 'TEST_DB1_USER', password: 'TEST_DB1_PASSWORD' } },
        },
      },
    }),
  );
  return buildContainer({
    workdir: '/tmp/x',
    exportDir: '/tmp/x-exports',
    configService,
    logger: new StderrLogger('silent'),
  });
}

describe('KeyedRegistry', () => {
  it('throws on duplicate discriminators at construction', () => {
    expect(() => new KeyedRegistry('thing', [{ id: 'a' }, { id: 'a' }], (t) => t.id)).toThrow(/duplicate thing/);
  });

  it('lists available keys in the unknown-key error', () => {
    const reg = new KeyedRegistry('thing', [{ id: 'a' }], (t) => t.id);
    expect(() => reg.get('b')).toThrow(/unknown thing "b" \(available: a\)/);
  });
});

describe('container', () => {
  it('builds and resolves the secret provider registry with the env provider', () => {
    const container = makeContainer();
    const registry = container.get<SecretProviderRegistry>(TYPES.SecretProviderRegistry);
    expect(registry.keys()).toContain('env');
  });

  it('resolves SecretsManager as a singleton', () => {
    const container = makeContainer();
    const a = container.get<SecretsManager>(TYPES.SecretsManager);
    const b = container.get<SecretsManager>(TYPES.SecretsManager);
    expect(a).toBe(b);
  });
});

describe('SecretsManager (env provider, end to end)', () => {
  it('renders options from environment variables and caches the result', async () => {
    process.env['TEST_DB1_USER'] = 'alice';
    process.env['TEST_DB1_PASSWORD'] = 'pw';
    try {
      const container = makeContainer();
      const manager = container.get<SecretsManager>(TYPES.SecretsManager);
      const first = await manager.getRenderedOptions('db1');
      expect(first.options).toEqual({ host: 'h', database: 'd', user: 'alice', password: 'pw' });

      // Cached: later env changes are not picked up without forceResolve.
      process.env['TEST_DB1_PASSWORD'] = 'changed';
      const second = await manager.getRenderedOptions('db1');
      expect(second.options['password']).toBe('pw');

      const forced = await manager.forceResolve('db1');
      expect(forced.options['password']).toBe('changed');
      manager.dispose();
    } finally {
      delete process.env['TEST_DB1_USER'];
      delete process.env['TEST_DB1_PASSWORD'];
    }
  });

  it('fails with the missing env var names', async () => {
    const container = makeContainer();
    const manager = container.get<SecretsManager>(TYPES.SecretsManager);
    await expect(manager.getRenderedOptions('db1')).rejects.toMatchObject({
      code: 'SECRET_RESOLUTION_FAILED',
      message: expect.stringContaining('TEST_DB1_USER'),
    });
    manager.dispose();
  });
});
