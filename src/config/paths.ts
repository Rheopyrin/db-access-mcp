import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Intentional spelling: the workdir product contract is `~/.db_acess_mcp`. */
export const DEFAULT_WORKDIR_NAME = '.db_acess_mcp';
export const CONFIG_FILE_NAME = 'config.json';
/** Default export directory. Not created at startup — made on demand per export. */
export const DEFAULT_EXPORT_DIR = '/tmp/db-access-mcp/exports';

/** Shells do not expand `~` on Windows, and never inside quoted args — do it ourselves. */
export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Workdir: holds config.json, conf.d/, instances/ and sso/ state. */
export function resolveWorkdir(cliValue?: string): string {
  const raw = cliValue ?? process.env['DB_ACCESS_MCP_WORKDIR'];
  if (raw && raw.trim() !== '') {
    return path.resolve(expandTilde(raw.trim()));
  }
  return path.join(os.homedir(), DEFAULT_WORKDIR_NAME);
}

/** Export dir: the directory query_to_file writes exports into (used directly). */
export function resolveExportDir(cliValue?: string): string {
  const raw = cliValue ?? process.env['DB_ACCESS_MCP_EXPORTDIR'];
  if (raw && raw.trim() !== '') {
    return path.resolve(expandTilde(raw.trim()));
  }
  return DEFAULT_EXPORT_DIR;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function instancesDir(workdir: string): string {
  return path.join(workdir, 'instances');
}
