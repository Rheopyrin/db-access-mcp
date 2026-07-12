import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config.service';
import { resolveDatabase } from '../../src/config/database-select';
import type { ConnectionConfig } from '../../src/config/schema';

function conn(options: Record<string, unknown>): ConnectionConfig {
  return parseConfig({ connections: { c: { type: 'postgres', options } } }).connections['c']!;
}

describe('resolveDatabase', () => {
  const single = conn({ host: 'h', database: 'main' });
  const multi = conn({ host: 'h', databases: ['a', 'b'] });
  const both = conn({ host: 'h', database: 'main', databases: ['a', 'b'] });

  it('no request: returns database', () => {
    expect(resolveDatabase('c', single)).toBe('main');
    expect(resolveDatabase('c', both)).toBe('main');
  });

  it('no request + only databases: DATABASE_NOT_FOUND listing available', () => {
    expect(() => resolveDatabase('c', multi)).toThrow(
      expect.objectContaining({ code: 'DATABASE_NOT_FOUND', hint: expect.stringContaining('a, b') }),
    );
  });

  it('request matching database or list member is accepted', () => {
    expect(resolveDatabase('c', single, 'main')).toBe('main');
    expect(resolveDatabase('c', multi, 'b')).toBe('b');
    expect(resolveDatabase('c', both, 'main')).toBe('main');
    expect(resolveDatabase('c', both, 'a')).toBe('a');
  });

  it('request outside the declared set: DATABASE_NOT_FOUND with available names', () => {
    for (const c of [single, multi, both]) {
      expect(() => resolveDatabase('c', c, 'nope')).toThrow(
        expect.objectContaining({ code: 'DATABASE_NOT_FOUND', message: expect.stringContaining('"nope"') }),
      );
    }
    expect(() => resolveDatabase('c', both, 'nope')).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('main, a, b') }),
    );
  });

  it('connectionString connection: no request passes through, a request errors', () => {
    const cs = conn({ connectionString: 'postgres://u:p@h:5432/csdb' });
    expect(resolveDatabase('c', cs)).toBeUndefined();
    expect(() => resolveDatabase('c', cs, 'csdb')).toThrow(
      expect.objectContaining({ code: 'DATABASE_NOT_FOUND', hint: expect.stringContaining('connection string') }),
    );
  });
});

describe('config validation of database declarations', () => {
  const wrap = (options: Record<string, unknown>) => () =>
    parseConfig({ connections: { c: { type: 'postgres', options } } });

  it('requires database or a non-empty databases list', () => {
    expect(wrap({ host: 'h' })).toThrow(/declare "database"/);
    expect(wrap({ host: 'h', databases: [] })).toThrow(/declare "database"/);
    expect(wrap({ host: 'h', databases: null })).toThrow(/declare "database"/);
    expect(wrap({ host: 'h', database: '' })).toThrow(/declare "database"/);
  });

  it('accepts database, databases, or both; connectionString is exempt', () => {
    expect(wrap({ host: 'h', database: 'd' })).not.toThrow();
    expect(wrap({ host: 'h', databases: ['a'] })).not.toThrow();
    expect(wrap({ host: 'h', database: 'd', databases: ['a'] })).not.toThrow();
    expect(wrap({ connectionString: 'postgres://u:p@h/db' })).not.toThrow();
  });

  it('rejects malformed databases lists', () => {
    expect(wrap({ host: 'h', databases: ['a', 'a'] })).toThrow(/duplicates/);
    expect(wrap({ host: 'h', databases: ['a', ''] })).toThrow(/non-empty strings/);
    expect(wrap({ host: 'h', databases: 'a' })).toThrow(/array/);
    expect(wrap({ connectionString: 'postgres://u:p@h/db', databases: ['a'] })).toThrow(/cannot be combined/);
    expect(wrap({ uri: 'mysql://u:p@h/db', databases: ['a'] })).toThrow(/cannot be combined/);
  });
});
