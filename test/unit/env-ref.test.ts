import { afterEach, describe, expect, it } from 'vitest';
import { resolveEnvRef } from '../../src/config/env-ref';

afterEach(() => {
  delete process.env['ENV_REF_TEST_VAR'];
});

describe('resolveEnvRef', () => {
  it('passes plain strings and undefined through', () => {
    expect(resolveEnvRef('inline-value', 'f')).toBe('inline-value');
    expect(resolveEnvRef(undefined, 'f')).toBeUndefined();
  });

  it('resolves {env: NAME} from the environment', () => {
    process.env['ENV_REF_TEST_VAR'] = 'resolved';
    expect(resolveEnvRef({ env: 'ENV_REF_TEST_VAR' }, 'f')).toBe('resolved');
  });

  it('fails with the variable and field name when the variable is missing or empty', () => {
    expect(() => resolveEnvRef({ env: 'ENV_REF_TEST_VAR' }, 'vault "vault-dr" address')).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('ENV_REF_TEST_VAR'),
      }),
    );
    process.env['ENV_REF_TEST_VAR'] = '';
    expect(() => resolveEnvRef({ env: 'ENV_REF_TEST_VAR' }, 'f')).toThrow(/not set/);
  });
});
