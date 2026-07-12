import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { csvEscape, csvLine, jsonlLine } from '../../src/server/exports/exporter';
import {
  BUFFERED_EXPORT_MAX_ROWS,
  formatFromPath,
  resolveExportPath,
  QueryToFileTool,
} from '../../src/server/tools/query-to-file.tool';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import type { DbPool, QueryOptions } from '../../src/interfaces/dialect-driver';
import type { QueryExecutor } from '../../src/pools/execute';
import { StderrLogger } from '../../src/logging/logger';

const logger = new StderrLogger('silent');

describe('csv/jsonl encoding', () => {
  it('escapes quotes, separators and newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('with,comma')).toBe('"with,comma"');
    expect(csvEscape('with "quotes"')).toBe('"with ""quotes"""');
    expect(csvEscape('multi\nline')).toBe('"multi\nline"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvEscape(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
  });

  it('builds lines', () => {
    expect(csvLine(['a', 1, null])).toBe('a,1,\n');
    expect(jsonlLine({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}\n');
  });
});

describe('resolveExportPath / formatFromPath', () => {
  it('resolves relative paths under the export dir', () => {
    expect(resolveExportPath('out.csv', '/wd/exports')).toBe(path.resolve('/wd/exports', 'out.csv'));
    expect(resolveExportPath('sub/out.csv', '/wd/exports')).toBe(path.resolve('/wd/exports', 'sub/out.csv'));
  });

  it('allows absolute/~ paths under the export dir or an allowed root', () => {
    expect(resolveExportPath('/wd/exports/a.csv', '/wd/exports')).toBe('/wd/exports/a.csv');
    expect(resolveExportPath('/data/a.csv', '/wd/exports', ['/data'])).toBe('/data/a.csv');
    expect(resolveExportPath('~/data/a.csv', '/wd/exports', ['~/data'])).toBe(path.join(os.homedir(), 'data/a.csv'));
  });

  it('rejects paths outside the export dir and allowed roots', () => {
    expect(() => resolveExportPath('/etc/passwd', '/wd/exports')).toThrow(/outside the allowed export/);
    expect(() => resolveExportPath('../escape.csv', '/wd/exports')).toThrow(/outside the allowed export/);
    expect(() => resolveExportPath('~/.ssh/authorized_keys', '/wd/exports')).toThrow(/outside the allowed export/);
    // A sibling dir sharing a name prefix must not be treated as inside.
    expect(() => resolveExportPath('/wd/exports-evil/a.csv', '/wd/exports')).toThrow(/outside the allowed export/);
  });

  it('infers the format from the extension with explicit override', () => {
    expect(formatFromPath('/x/a.csv')).toBe('csv');
    expect(formatFromPath('/x/a.jsonl')).toBe('jsonl');
    expect(formatFromPath('/x/a.ndjson')).toBe('jsonl');
    expect(formatFromPath('/x/a.dat')).toBe('csv');
    expect(formatFromPath('/x/a.csv', 'jsonl')).toBe('jsonl');
  });
});

function toolWith(pool: DbPool, workdir: string): QueryToFileTool {
  const configService = new ConfigService(
    parseConfig({ connections: { db1: { type: 'postgres', options: { host: 'h', database: 'd' } } } }),
  );
  const executor = {
    execute: async <T>(_key: string, work: (pool: DbPool) => Promise<T>) => work(pool),
  } as unknown as QueryExecutor;
  return new QueryToFileTool(workdir, configService, executor, logger);
}

function bufferedPool(rows: Record<string, unknown>[], truncated = false): DbPool {
  return {
    async query(_sql: string, opts: QueryOptions) {
      const sliced = rows.slice(0, opts.maxRows);
      return {
        columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })),
        rows: sliced,
        rowCount: sliced.length,
        truncated: truncated || sliced.length < rows.length,
        elapsedMs: 1,
      };
    },
    async ping() {},
    async end() {},
  };
}

describe('QueryToFileTool', () => {
  it('writes a csv via the buffered fallback and reports streamed=false', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-'));
    const tool = toolWith(bufferedPool([{ id: 1, name: 'a,b' }, { id: 2, name: 'plain' }]), workdir);
    const result = await tool.execute({ connection: 'db1', query: 'SELECT 1', file_path: 'out/data.csv' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured['streamed']).toBe(false);
    expect(structured['rows_written']).toBe(2);
    const content = fs.readFileSync(path.join(workdir, 'out/data.csv'), 'utf8');
    expect(content).toBe('id,name\n1,"a,b"\n2,plain\n');
  });

  it('streams when the pool supports queryStream and respects max_rows', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-'));
    const pool: DbPool = {
      ...bufferedPool([]),
      async queryStream(_sql, _opts, onRow) {
        for (let i = 1; i <= 5; i += 1) await onRow({ n: i });
        return { columns: [{ name: 'n' }], rowCount: 5 };
      },
    };
    const tool = toolWith(pool, workdir);
    const result = await tool.execute({
      connection: 'db1',
      query: 'SELECT n',
      file_path: 'nums.jsonl',
      max_rows: 3,
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured['streamed']).toBe(true);
    expect(structured['rows_written']).toBe(3);
    expect(structured['truncated']).toBe(true);
    const lines = fs.readFileSync(path.join(workdir, 'nums.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it('refuses to overwrite without overwrite=true', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-'));
    const target = path.join(workdir, 'exists.csv');
    fs.writeFileSync(target, 'old');
    const tool = toolWith(bufferedPool([{ a: 1 }]), workdir);

    const refused = await tool.execute({ connection: 'db1', query: 'q', file_path: target });
    expect(refused.isError).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('old');

    const replaced = await tool.execute({ connection: 'db1', query: 'q', file_path: target, overwrite: true });
    expect(replaced.isError).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toContain('a\n1');
  });

  it('caps the buffered path at BUFFERED_EXPORT_MAX_ROWS even for larger max_rows', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-'));
    let requestedMaxRows: number | undefined;
    const pool: DbPool = {
      async query(_sql, opts) {
        requestedMaxRows = opts.maxRows;
        return { columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 1 };
      },
      async ping() {},
      async end() {},
    };
    const tool = toolWith(pool, workdir);
    await tool.execute({ connection: 'db1', query: 'q', file_path: 'x.csv', max_rows: 10_000_000 });
    expect(requestedMaxRows).toBe(BUFFERED_EXPORT_MAX_ROWS);
  });

  it('writes the csv header even for empty results', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-'));
    const pool: DbPool = {
      async query() {
        return { columns: [{ name: 'id' }, { name: 'v' }], rows: [], rowCount: 0, truncated: false, elapsedMs: 1 };
      },
      async ping() {},
      async end() {},
    };
    const tool = toolWith(pool, workdir);
    await tool.execute({ connection: 'db1', query: 'q', file_path: 'empty.csv' });
    expect(fs.readFileSync(path.join(workdir, 'empty.csv'), 'utf8')).toBe('id,v\n');
  });

  it('rejects a file_path outside the export dir and allowed roots', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-'));
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-out-')), 'evil.csv');
    const tool = toolWith(bufferedPool([{ a: 1 }]), workdir);
    const result = await tool.execute({ connection: 'db1', query: 'q', file_path: outside });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as Record<string, unknown>)['message']).toMatch(/outside the allowed export/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('honors allow_export_paths for absolute targets outside the workdir', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-'));
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qtf-allowed-'));
    const configService = new ConfigService(
      parseConfig({
        allow_export_paths: [allowedRoot],
        connections: { db1: { type: 'postgres', options: { host: 'h', database: 'd' } } },
      }),
    );
    const executor = {
      execute: async <T>(_key: string, work: (pool: DbPool) => Promise<T>) => work(pool),
    } as unknown as QueryExecutor;
    const pool = bufferedPool([{ a: 1 }]);
    const tool = new QueryToFileTool(workdir, configService, executor, logger);
    const target = path.join(allowedRoot, 'nested', 'ok.csv');
    const result = await tool.execute({ connection: 'db1', query: 'q', file_path: target });
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toContain('a\n1');
  });
});
