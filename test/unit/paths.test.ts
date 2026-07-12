import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expandTilde, resolveExportDir, resolveWorkdir } from '../../src/config/paths';

afterEach(() => {
  delete process.env['DB_ACCESS_MCP_WORKDIR'];
  delete process.env['DB_ACCESS_MCP_EXPORTDIR'];
});

describe('expandTilde', () => {
  it('expands ~ and ~/', () => {
    expect(expandTilde('~')).toBe(os.homedir());
    expect(expandTilde('~/x/y')).toBe(path.join(os.homedir(), 'x/y'));
  });

  it('leaves other paths untouched', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path');
    expect(expandTilde('rel/~x')).toBe('rel/~x');
  });
});

describe('resolveWorkdir', () => {
  it('defaults to ~/.db_acess_mcp (intentional spelling)', () => {
    expect(resolveWorkdir()).toBe(path.join(os.homedir(), '.db_acess_mcp'));
  });

  it('prefers the CLI value over the env var', () => {
    process.env['DB_ACCESS_MCP_WORKDIR'] = '/from/env';
    expect(resolveWorkdir('~/cli-dir')).toBe(path.join(os.homedir(), 'cli-dir'));
  });

  it('uses the env var when no CLI value is given', () => {
    process.env['DB_ACCESS_MCP_WORKDIR'] = '/from/env';
    expect(resolveWorkdir()).toBe(path.resolve('/from/env'));
  });
});

describe('resolveExportDir', () => {
  it('defaults to ~/db_access_mcp/exports', () => {
    expect(resolveExportDir()).toBe(path.join(os.homedir(), 'db_access_mcp', 'exports'));
  });

  it('prefers the CLI value over the env var', () => {
    process.env['DB_ACCESS_MCP_EXPORTDIR'] = '/from/env';
    expect(resolveExportDir('~/cli-dir')).toBe(path.join(os.homedir(), 'cli-dir'));
  });

  it('uses the env var when no CLI value is given', () => {
    process.env['DB_ACCESS_MCP_EXPORTDIR'] = '/from/env';
    expect(resolveExportDir()).toBe(path.resolve('/from/env'));
  });
});

