export interface Placeholder {
  /** Full match, e.g. `${vault.data.password}`. */
  raw: string;
  /** Provider namespace, e.g. `vault`. */
  provider: string;
  /** Dot-path inside the resolved secret object, e.g. `data.password`. */
  path: string;
}

export const PLACEHOLDER_RE = /\$\{([a-zA-Z_][\w-]*)\.([^}]+)\}/g;

export function parsePlaceholders(value: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const m of value.matchAll(PLACEHOLDER_RE)) {
    out.push({ raw: m[0], provider: m[1] as string, path: m[2] as string });
  }
  return out;
}

/** Recursively collects placeholders from every string value in an options object. */
export function collectPlaceholders(value: unknown, acc: Placeholder[] = []): Placeholder[] {
  if (typeof value === 'string') {
    acc.push(...parsePlaceholders(value));
  } else if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectPlaceholders(item, acc);
  }
  return acc;
}

export function getByDotPath(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as Record<string, unknown>))) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
