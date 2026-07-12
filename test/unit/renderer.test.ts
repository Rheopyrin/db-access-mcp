import { describe, expect, it } from 'vitest';
import { fingerprintOptions, renderOptions } from '../../src/secrets/renderer';

const secret = {
  userName: 'alice',
  password: 'pw',
  data: { nested: { port: 6543 } },
};

describe('renderOptions', () => {
  it('renders whole-string placeholders preserving the raw value type', () => {
    const out = renderOptions(
      { user: '${env.userName}', port: '${env.data.nested.port}' },
      'env',
      secret,
      'db1',
    );
    expect(out).toEqual({ user: 'alice', port: 6543 });
  });

  it('renders embedded placeholders by string substitution', () => {
    const out = renderOptions(
      { connectionString: 'postgres://${env.userName}:${env.password}@h:5432/db' },
      'env',
      secret,
      'db1',
    );
    expect(out).toEqual({ connectionString: 'postgres://alice:pw@h:5432/db' });
  });

  it('renders inside nested objects and arrays', () => {
    const out = renderOptions({ a: { b: ['${env.userName}', 'plain'] } }, 'env', secret, 'db1');
    expect(out).toEqual({ a: { b: ['alice', 'plain'] } });
  });

  it('throws SECRET_RESOLUTION_FAILED for a missing dot-path', () => {
    expect(() => renderOptions({ x: '${env.missing.path}' }, 'env', secret, 'db1')).toThrow(
      expect.objectContaining({ code: 'SECRET_RESOLUTION_FAILED' }),
    );
  });

  it('throws CONFIG_INVALID for a mismatched provider namespace', () => {
    expect(() => renderOptions({ x: '${vault.password}' }, 'env', secret, 'db1')).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('leaves strings without placeholders untouched', () => {
    const out = renderOptions({ host: 'db.internal', tags: [1, true, null] }, 'env', secret, 'db1');
    expect(out).toEqual({ host: 'db.internal', tags: [1, true, null] });
  });
});

describe('fingerprintOptions', () => {
  it('is stable regardless of key order', () => {
    expect(fingerprintOptions({ a: 1, b: { c: 2, d: 3 } })).toBe(
      fingerprintOptions({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('changes when a value changes', () => {
    expect(fingerprintOptions({ a: 1 })).not.toBe(fingerprintOptions({ a: 2 }));
  });
});
