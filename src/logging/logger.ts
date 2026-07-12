import type { Logger, LogLevel } from '../interfaces/logger';

const LEVEL_ORDER: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /pass(word)?|token|secret|priv(ate)?key|credential|api[_-]?key|passphrase/i;
const MAX_DEPTH = 6;
/** Masks the password in a `scheme://user:password@host` URI regardless of the field name. */
const URI_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi;

function scrubString(value: string): string {
  return value.replace(URI_CREDENTIALS, '$1:[redacted]@');
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1, seen));
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack !== undefined ? scrubString(value.stack) : undefined,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1, seen);
  }
  return out;
}

/**
 * JSON-lines logger writing exclusively to stderr. On a stdio MCP server,
 * stdout belongs to the protocol transport — nothing else may write there.
 */
export class StderrLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  private write(level: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>): void {
    if (this.level === 'silent' || LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(redact({ ...this.bindings, ...fields }) as Record<string, unknown>),
    };
    try {
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    } catch {
      // Logging must never crash the server (e.g. EPIPE on closed stderr).
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.write('error', msg, fields);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new StderrLogger(this.level, { ...this.bindings, ...bindings });
  }
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'silent') {
    return value;
  }
  return fallback;
}
