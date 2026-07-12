import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isDbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function okResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, jsonReplacer, 2) }],
    structuredContent: payload,
  };
}

/**
 * Tools never leak stacks or credentials to the model: DbAccessError exposes
 * its safe code/message/hint; anything else becomes a generic message with
 * full details logged to stderr.
 */
export function errorResult(err: unknown, logger: Logger, tool: string): CallToolResult {
  let payload: Record<string, unknown>;
  if (isDbAccessError(err)) {
    payload = { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) };
  } else {
    payload = { code: 'INTERNAL', message: (err as Error)?.message ?? String(err) };
  }
  logger.error('tool failed', { tool, err });
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, jsonReplacer, 2) }],
    structuredContent: payload,
    isError: true,
  };
}
