import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMergedConfig } from '../../src/config/loader';

function makeWorkdir(files: Record<string, unknown>): string {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(workdir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return workdir;
}

const CONN = (host: string) => ({ type: 'postgres', options: { host, port: 5432, database: 'd', user: 'u' } });

describe('loadMergedConfig', () => {
  it('merges config.json with conf.d files (record sections unioned)', () => {
    const workdir = makeWorkdir({
      'config.json': { connections: { a: CONN('a') }, pool: { max: 3 } },
      'conf.d/10-extra.json': { connections: { b: CONN('b') }, tunnels: {} },
      'conf.d/20-more.json': { connections: { c: CONN('c') } },
    });
    const { config, files } = loadMergedConfig(workdir);
    expect(Object.keys(config.connections).sort()).toEqual(['a', 'b', 'c']);
    expect(config.pool.max).toBe(3);
    expect(files.map((f) => path.basename(f))).toEqual(['config.json', '10-extra.json', '20-more.json']);
  });

  it('works without config.json when conf.d has files', () => {
    const workdir = makeWorkdir({ 'conf.d/a.json': { connections: { a: CONN('a') } } });
    const { config } = loadMergedConfig(workdir);
    expect(Object.keys(config.connections)).toEqual(['a']);
  });

  it('fails on duplicate named entries naming both files', () => {
    const workdir = makeWorkdir({
      'config.json': { connections: { a: CONN('one') } },
      'conf.d/z.json': { connections: { a: CONN('two') } },
    });
    expect(() => loadMergedConfig(workdir)).toThrow(/connections "a" is defined in both .*config\.json and .*z\.json/);
  });

  it('fails when a scalar section appears in two files', () => {
    const workdir = makeWorkdir({
      'config.json': { connections: {}, limits: { max_rows: 10 } },
      'conf.d/a.json': { limits: { max_rows: 20 } },
    });
    expect(() => loadMergedConfig(workdir)).toThrow(/section "limits" is defined in both/);
  });

  it('ignores dotfiles and non-json files in conf.d', () => {
    const workdir = makeWorkdir({
      'config.json': { connections: {} },
      'conf.d/.hidden.json': { connections: { hidden: CONN('h') } },
      'conf.d/readme.txt': 'not json',
    });
    const { config } = loadMergedConfig(workdir);
    expect(Object.keys(config.connections)).toEqual([]);
  });

  it('with an explicit config path loads only that file (no conf.d scan)', () => {
    const workdir = makeWorkdir({
      'custom.json': { connections: { only: CONN('x') } },
      'conf.d/extra.json': { connections: { extra: CONN('y') } },
    });
    const { config, files } = loadMergedConfig(workdir, path.join(workdir, 'custom.json'));
    expect(Object.keys(config.connections)).toEqual(['only']);
    expect(files).toHaveLength(1);
  });

  it('fails with a hint when nothing is found', () => {
    const workdir = makeWorkdir({});
    expect(() => loadMergedConfig(workdir)).toThrow(/no configuration found/);
  });

  it('names the file on JSON syntax errors', () => {
    const workdir = makeWorkdir({ 'config.json': '{broken' });
    expect(() => loadMergedConfig(workdir)).toThrow(/config\.json is not valid JSON/);
  });

  it('cross-file semantic validation works on the merged result', () => {
    const workdir = makeWorkdir({
      'config.json': { tunnels: { t1: { type: 'ssm', options: { target: 'i-1' } } } },
      'conf.d/conns.json': {
        connections: { a: { ...CONN('a'), tunnel: { target: 't1' } } },
      },
    });
    expect(() => loadMergedConfig(workdir)).not.toThrow();
  });
});
