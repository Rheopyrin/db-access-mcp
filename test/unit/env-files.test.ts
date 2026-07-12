import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEnvFiles, _setRealEnvKeyForTests } from '../../src/config/env-files';
import { StderrLogger } from '../../src/logging/logger';
import type { Logger } from '../../src/interfaces/logger';

const silent = new StderrLogger('silent');
const touched: string[] = [];

function envFile(content: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envf-')), 'test.env');
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function track(...keys: string[]): void {
  touched.push(...keys);
}

afterEach(() => {
  for (const key of touched) {
    delete process.env[key];
    _setRealEnvKeyForTests(key, false);
  }
  touched.length = 0;
});

describe('applyEnvFiles', () => {
  it('applies variables from a file', () => {
    track('ENVF_A', 'ENVF_B');
    const file = envFile('ENVF_A=hello\nENVF_B="quoted value"\n');
    applyEnvFiles([file], silent);
    expect(process.env['ENVF_A']).toBe('hello');
    expect(process.env['ENVF_B']).toBe('quoted value');
  });

  it('never overrides variables from the real environment', () => {
    track('ENVF_REAL');
    process.env['ENVF_REAL'] = 'from-real-env';
    _setRealEnvKeyForTests('ENVF_REAL', true);
    applyEnvFiles([envFile('ENVF_REAL=from-file\n')], silent);
    expect(process.env['ENVF_REAL']).toBe('from-real-env');
  });

  it('later files override earlier ones', () => {
    track('ENVF_ORDER');
    applyEnvFiles([envFile('ENVF_ORDER=first\n'), envFile('ENVF_ORDER=second\n')], silent);
    expect(process.env['ENVF_ORDER']).toBe('second');
  });

  it('skips denylisted variables with a warning and applies the rest', () => {
    track('ENVF_OK');
    const warnings: string[] = [];
    const logger: Logger = {
      ...silent,
      warn: (msg, fields) => warnings.push(`${msg} ${JSON.stringify(fields)}`),
      debug: () => {},
      info: () => {},
      error: () => {},
      child: () => logger,
    };
    const before = process.env['PATH'];
    applyEnvFiles([envFile('PATH=/evil\nNODE_OPTIONS=--require /evil.js\nEnvf_OK=1\nENVF_OK=yes\n')], logger);
    expect(process.env['PATH']).toBe(before);
    expect(warnings.some((w) => w.includes('denylisted') && w.includes('PATH'))).toBe(true);
    expect(warnings.some((w) => w.includes('NODE_OPTIONS'))).toBe(true);
    expect(process.env['ENVF_OK']).toBe('yes');
  });

  it('denylists the Windows PATHEXT/COMSPEC spawn-steering variables', () => {
    track('ENVF_KEEP');
    const warnings: string[] = [];
    const logger: Logger = {
      ...silent,
      warn: (msg, fields) => warnings.push(`${msg} ${JSON.stringify(fields)}`),
      debug: () => {},
      info: () => {},
      error: () => {},
      child: () => logger,
    };
    const pathext = process.env['PATHEXT'];
    const comspec = process.env['COMSPEC'];
    applyEnvFiles([envFile('PATHEXT=.evil\nCOMSPEC=/evil/cmd\nENVF_KEEP=1\n')], logger);
    expect(process.env['PATHEXT']).toBe(pathext);
    expect(process.env['COMSPEC']).toBe(comspec);
    expect(warnings.some((w) => w.includes('denylisted') && w.includes('PATHEXT'))).toBe(true);
    expect(warnings.some((w) => w.includes('denylisted') && w.includes('COMSPEC'))).toBe(true);
    expect(process.env['ENVF_KEEP']).toBe('1');
  });

  it('fails with CONFIG_INVALID for a missing file', () => {
    expect(() => applyEnvFiles(['/definitely/missing.env'], silent)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID', message: expect.stringContaining('missing.env') }),
    );
  });

  it('warns when the file is group/other readable (posix)', () => {
    if (process.platform === 'win32') return;
    track('ENVF_PERm', 'ENVF_PERM');
    const file = envFile('ENVF_PERM=1\n');
    fs.chmodSync(file, 0o644);
    const warn = vi.fn();
    const logger: Logger = { ...silent, warn, debug: () => {}, info: () => {}, error: () => {}, child: () => logger };
    applyEnvFiles([file], logger);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('readable by group/other'), expect.anything());
  });
});
