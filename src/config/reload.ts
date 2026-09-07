import { DEFAULT_POOL, type Config, type PoolSettings } from './schema';

export interface SectionDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export interface ConfigDiff {
  connections: SectionDiff;
  tunnels: SectionDiff;
  /** Sections whose effect is global: a change there touches every connection. */
  poolDefaultsChanged: boolean;
  limitsChanged: boolean;
  envFilesChanged: boolean;
}

/**
 * Order-independent structural equality. Config values are plain JSON (the zod
 * schema only ever produces objects/arrays/primitives), so key order — which
 * differs between two hand-edited files describing the same thing — must not
 * count as a change.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function diffRecords(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  equal: (key: string) => boolean,
): SectionDiff {
  const diff: SectionDiff = { added: [], removed: [], changed: [], unchanged: [] };
  for (const key of Object.keys(next)) {
    if (!(key in previous)) diff.added.push(key);
    else if (equal(key)) diff.unchanged.push(key);
    else diff.changed.push(key);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) diff.removed.push(key);
  }
  diff.added.sort();
  diff.removed.sort();
  diff.changed.sort();
  diff.unchanged.sort();
  return diff;
}

/** Global defaults merged into a connection's own pool block, as PoolManager sees them. */
function effectivePool(config: Config, key: string): Required<PoolSettings> {
  return { ...DEFAULT_POOL, ...config.pool, ...config.connections[key]?.pool };
}

/**
 * Compares two configurations. A connection counts as "changed" when either its
 * own definition or its EFFECTIVE pool settings differ — a change to the global
 * "pool" section alters how every pool is built and must invalidate them too.
 */
export function diffConfigs(previous: Config, next: Config): ConfigDiff {
  return {
    connections: diffRecords(
      previous.connections,
      next.connections,
      (key) =>
        deepEqual(previous.connections[key], next.connections[key]) &&
        deepEqual(effectivePool(previous, key), effectivePool(next, key)),
    ),
    tunnels: diffRecords(previous.tunnels, next.tunnels, (key) => deepEqual(previous.tunnels[key], next.tunnels[key])),
    poolDefaultsChanged: !deepEqual(previous.pool, next.pool),
    limitsChanged: !deepEqual(previous.limits, next.limits),
    envFilesChanged: !deepEqual(previous.env_files, next.env_files),
  };
}
