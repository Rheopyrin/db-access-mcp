import fs from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import type { ConfigService } from '../../config/config.service';
import { resolveDatabase } from '../../config/database-select';
import { expandTilde } from '../../config/paths';
import { DbAccessError } from '../../errors';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import type { QueryExecutor } from '../../pools/execute';
import { FileExportWriter, type ExportFormat } from '../exports/exporter';
import { errorResult, okResult } from '../results';

/** Hard cap for dialects without streaming (redshift, mssql): rows are buffered in memory. */
export const BUFFERED_EXPORT_MAX_ROWS = 100_000;
const MAX_TIMEOUT_MS = 600_000;

/** True when `target` is `root` itself or nested below it (no `..` escape). */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Resolves and confines an export path. Relative paths resolve under the
 * default export dir (<workdir>/exports); absolute / `~`-prefixed paths must
 * fall under the export dir or one of the config's allow_export_paths roots.
 * Anything outside is rejected — the model cannot write over ~/.ssh, dotfiles
 * or the config dir.
 */
export function resolveExportPath(rawPath: string, exportDir: string, allowedRoots: string[] = []): string {
  const expanded = expandTilde(rawPath.trim());
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(exportDir, expanded);
  const roots = [exportDir, ...allowedRoots.map((r) => path.resolve(expandTilde(r)))];
  if (!roots.some((root) => isWithin(root, resolved))) {
    throw new DbAccessError('QUERY_FAILED', `file_path "${resolved}" is outside the allowed export directories`, {
      hint: `Write under ${roots.join(', ')} — or add a root to "allow_export_paths" in the config.`,
    });
  }
  return resolved;
}

export function formatFromPath(filePath: string, explicit?: string): ExportFormat {
  if (explicit === 'csv' || explicit === 'jsonl') return explicit;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  return 'csv';
}

export class QueryToFileTool implements McpTool {
  readonly name = 'query_to_file';
  readonly description =
    'Execute a SQL query and write the full result to a file (csv or jsonl) instead of returning rows — ' +
    'use this for large exports that must not go through the model context. Relative file_path resolves ' +
    'under the export dir (default /tmp/db-access-mcp/exports); absolute or ~-prefixed paths must fall under ' +
    'the export dir or a configured allow_export_paths root. Parent directories are created. Existing files ' +
    'are not overwritten unless overwrite=true. postgres/mysql stream rows (no row limit by default); ' +
    `redshift/mssql buffer in memory and are capped at ${BUFFERED_EXPORT_MAX_ROWS} rows.`;
  readonly inputSchema: ZodRawShape = {
    connection: z.string().describe('Connection key from connection_list'),
    database: z
      .string()
      .optional()
      .describe('Database to export from; required when the connection declares multiple databases'),
    query: z.string().describe('SQL text to execute (single statement for streamed dialects)'),
    file_path: z
      .string()
      .describe('Target file path: relative to the export dir, or absolute/~ under an allowed export root'),
    format: z.enum(['csv', 'jsonl']).optional().describe('Output format; default inferred from the file extension'),
    max_rows: z.number().int().min(1).optional().describe('Optional row cap for the export'),
    timeout_ms: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional().describe('Query timeout (default from config)'),
    overwrite: z.boolean().optional().describe('Replace the file if it already exists (default false)'),
  };

  constructor(
    private readonly exportDir: string,
    private readonly configService: ConfigService,
    private readonly executor: QueryExecutor,
    private readonly logger: Logger,
  ) {}

  async execute(args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const connectionKey = args['connection'] as string;
      const sql = args['query'] as string;
      const database = resolveDatabase(
        connectionKey,
        this.configService.getConnection(connectionKey),
        args['database'] as string | undefined,
      );
      const maxRows = args['max_rows'] as number | undefined;
      const overwrite = (args['overwrite'] as boolean | undefined) ?? false;
      const limits = this.configService.effectiveLimits(connectionKey);
      const timeoutMs = Math.min((args['timeout_ms'] as number | undefined) ?? limits.query_timeout_ms, MAX_TIMEOUT_MS);

      const filePath = resolveExportPath(
        args['file_path'] as string,
        this.exportDir,
        this.configService.allowExportPaths,
      );
      const format = formatFromPath(filePath, args['format'] as string | undefined);
      if (!overwrite && fs.existsSync(filePath)) {
        throw new DbAccessError('QUERY_FAILED', `file already exists: ${filePath}`, {
          hint: 'Pass overwrite=true to replace it, or choose another file_path.',
        });
      }
      // Create the export dir (and any parents) on demand — recursive mkdir is a
      // no-op if it already exists, so nothing is pre-created at startup.
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      const started = Date.now();
      this.logger.info('export started', { connection: connectionKey, file: filePath, format });
      const result = await this.executor.execute(connectionKey, async (pool) => {
        const writer = new FileExportWriter(filePath, format);
        try {
          if (pool.queryStream) {
            let written = 0;
            let capped = false;
            const stream = await pool.queryStream(sql, { timeoutMs }, async (row) => {
              if (maxRows !== undefined && written >= maxRows) {
                capped = true;
                return; // drain the remainder without writing
              }
              await writer.writeRow(row, Object.keys(row));
              written += 1;
            });
            await writer.finalize(stream.columns.map((c) => c.name));
            return { rows_written: written, truncated: capped, streamed: true };
          }

          const cap = Math.min(maxRows ?? BUFFERED_EXPORT_MAX_ROWS, BUFFERED_EXPORT_MAX_ROWS);
          const buffered = await pool.query(sql, { maxRows: cap, timeoutMs });
          const columnNames = buffered.columns.map((c) => c.name);
          for (const row of buffered.rows) {
            await writer.writeRow(row, columnNames.length > 0 ? columnNames : Object.keys(row));
          }
          await writer.finalize(columnNames);
          return { rows_written: buffered.rowCount, truncated: buffered.truncated, streamed: false };
        } catch (err) {
          await writer.abort();
          throw err;
        }
      }, { database });

      return okResult({
        file: filePath,
        format,
        ...result,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }
}
