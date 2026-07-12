import { describe, expect, it } from 'vitest';
import { redact } from '../../src/logging/logger';

describe('redact', () => {
  it('redacts sensitive keys at any depth', () => {
    const input = {
      user: 'alice',
      password: 'hunter2',
      nested: { apiKey: 'k', privateKey: 'pk', token: 't', passphrase: 'x', fine: 1 },
      list: [{ secret: 's', ok: true }],
    };
    expect(redact(input)).toEqual({
      user: 'alice',
      password: '[redacted]',
      nested: { apiKey: '[redacted]', privateKey: '[redacted]', token: '[redacted]', passphrase: '[redacted]', fine: 1 },
      list: [{ secret: '[redacted]', ok: true }],
    });
  });

  it('handles circular structures', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(redact(a)).toEqual({ name: 'a', self: '[circular]' });
  });

  it('serializes errors to plain objects', () => {
    const out = redact({ err: new Error('boom') }) as Record<string, Record<string, unknown>>;
    expect(out['err']?.['message']).toBe('boom');
  });

  it('masks inline credentials in connection-string values regardless of key name', () => {
    const out = redact({
      connectionString: 'postgres://alice:s3cr3t@db.example.com:5432/app',
      uri: 'mysql://u:p@h/db',
      plain: 'no creds here',
    }) as Record<string, string>;
    expect(out['connectionString']).toBe('postgres://alice:[redacted]@db.example.com:5432/app');
    expect(out['uri']).toBe('mysql://u:[redacted]@h/db');
    expect(out['plain']).toBe('no creds here');
  });

  it('masks credentials leaked into an error message', () => {
    const out = redact({ err: new Error('connect failed: postgres://u:pw@h:5432/db') }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(out['err']?.['message']).toBe('connect failed: postgres://u:[redacted]@h:5432/db');
  });
});
