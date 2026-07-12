import { createHash } from 'node:crypto';
import { DbAccessError } from '../errors';
import { getByDotPath, parsePlaceholders, PLACEHOLDER_RE } from './placeholders';

/**
 * Renders `${provider.dot.path}` placeholders inside an options object.
 * A string that IS a single placeholder is replaced by the raw resolved value
 * (preserving numbers/booleans, e.g. ports); otherwise occurrences are
 * stringified and substituted in place.
 */
export function renderOptions(
  options: Record<string, unknown>,
  providerName: string,
  secretData: Record<string, unknown>,
  connectionKey: string,
): Record<string, unknown> {
  const resolvePath = (raw: string, provider: string, path: string): unknown => {
    if (provider !== providerName) {
      throw new DbAccessError(
        'CONFIG_INVALID',
        `connection "${connectionKey}": placeholder ${raw} does not match secret provider "${providerName}"`,
      );
    }
    const value = getByDotPath(secretData, path);
    if (value === undefined) {
      throw new DbAccessError(
        'SECRET_RESOLUTION_FAILED',
        `connection "${connectionKey}": secret path "${path}" not found in resolved "${providerName}" secret`,
        { hint: `Available top-level keys: ${Object.keys(secretData).join(', ') || 'none'}` },
      );
    }
    return value;
  };

  const renderValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const placeholders = parsePlaceholders(value);
      if (placeholders.length === 0) return value;
      const only = placeholders[0];
      if (placeholders.length === 1 && only && only.raw === value) {
        return resolvePath(only.raw, only.provider, only.path);
      }
      return value.replace(PLACEHOLDER_RE, (raw, provider: string, path: string) =>
        String(resolvePath(raw, provider, path)),
      );
    }
    if (Array.isArray(value)) return value.map(renderValue);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = renderValue(v);
      return out;
    }
    return value;
  };

  return renderValue(options) as Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Stable fingerprint of rendered options — detects credential rotation. */
export function fingerprintOptions(options: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(options)).digest('hex');
}
