import { DbAccessError } from '../errors';
import type { EnvRefString } from './schema';

/**
 * Resolves an env-ref config value: plain strings pass through, {env: NAME}
 * reads process.env. Called lazily at point of use so that a missing variable
 * only fails the connections that actually need it, and resolved secrets are
 * never materialized into the parsed config.
 */
export function resolveEnvRef(value: EnvRefString | undefined, field: string): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  const resolved = process.env[value.env];
  if (resolved === undefined || resolved === '') {
    throw new DbAccessError(
      'CONFIG_INVALID',
      `${field} references environment variable "${value.env}" which is not set`,
      { hint: 'Set the variable, load it via env_files/--env-file, or inline the value.' },
    );
  }
  return resolved;
}
