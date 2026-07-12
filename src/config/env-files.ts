import fs from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { DbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';
import { expandTilde } from './paths';

/**
 * Variables that influence process spawning, module loading or TLS trust.
 * Allowing an env file to set these would let a config-adjacent file hijack
 * the aws/session-manager-plugin binaries we spawn — always skipped.
 */
const DENYLIST = new Set([
  'PATH',
  // Windows: PATHEXT/COMSPEC steer which executable (and shell) spawn resolves.
  'PATHEXT',
  'COMSPEC',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

/** Snapshot of the real environment taken before any env file is applied. */
const realEnvKeys = new Set(Object.keys(process.env));

/** Test hook: pretend the given key was/wasn't part of the original environment. */
export function _setRealEnvKeyForTests(key: string, present: boolean): void {
  if (present) realEnvKeys.add(key);
  else realEnvKeys.delete(key);
}

/**
 * Applies extra .env files to process.env.
 *
 * Security rules:
 *  - the REAL environment always wins: keys present at process start are
 *    never overridden by any file;
 *  - denylisted variables (PATH, loader/TLS hooks) are skipped with a warning;
 *  - later files override earlier ones (config env_files first, then CLI
 *    --env-file, in order);
 *  - values are never logged.
 */
export function applyEnvFiles(paths: string[], logger: Logger): void {
  for (const rawPath of paths) {
    const file = expandTilde(rawPath);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new DbAccessError('CONFIG_INVALID', `cannot read env file ${file}`, {
        hint: 'Check the "env_files" config section and --env-file arguments.',
        cause: err,
      });
    }

    if (process.platform !== 'win32') {
      try {
        const mode = fs.statSync(file).mode;
        if ((mode & 0o044) !== 0) {
          logger.warn('env file is readable by group/other — consider chmod 600', { file });
        }
      } catch {
        /* stat failed; read already succeeded, ignore */
      }
    }

    const parsed = parseDotenv(text);
    const applied: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (DENYLIST.has(key.toUpperCase())) {
        logger.warn('env file variable skipped (denylisted)', { file, key });
        continue;
      }
      if (realEnvKeys.has(key)) {
        logger.debug('env file variable skipped (set in the real environment)', { file, key });
        continue;
      }
      process.env[key] = value;
      applied.push(key);
    }
    logger.debug('env file applied', { file, keys: applied });
  }
}
