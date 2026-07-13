/**
 * db-access-mcp entrypoint.
 *
 * stdout is reserved for the MCP stdio transport: the very first thing we do
 * is rebind console.* to stderr so no dependency can ever corrupt the protocol.
 */
 
console.log = console.error.bind(console);
console.info = console.error.bind(console);
console.warn = console.error.bind(console);
console.debug = console.error.bind(console);

import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigService } from '../config/config.service';
import { applyEnvFiles } from '../config/env-files';
import { seedWorkdir } from '../config/first-run';
import { loadMergedConfig } from '../config/loader';
import { expandTilde, resolveExportDir, resolveWorkdir } from '../config/paths';
import { isDbAccessError } from '../errors';
import { parseLogLevel, StderrLogger } from '../logging/logger';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      workdir: { type: 'string' },
      exportdir: { type: 'string' },
      config: { type: 'string' },
      'env-file': { type: 'string', multiple: true },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(
      [
        'Usage: db-access-mcp [workdir] [exportdir] [--workdir <dir>] [--exportdir <dir>]',
        '                     [--config <file>] [--env-file <file>]... [--log-level <debug|info|warn|error|silent>]',
        '',
        'Defaults: workdir ~/.db_acess_mcp (config.json + conf.d/*.json, instances/, sso/);',
        '          exportdir /tmp/db-access-mcp/exports (where query_to_file writes exports; made on demand).',
        'With --config <file> only that file is loaded (no conf.d scan).',
        '--env-file may be repeated; files are applied after the config env_files list.',
        'Environment: DB_ACCESS_MCP_WORKDIR, DB_ACCESS_MCP_EXPORTDIR, DB_ACCESS_MCP_CONFIG, DB_ACCESS_MCP_LOG_LEVEL.',
        '',
      ].join('\n'),
    );
    return;
  }

  const workdir = resolveWorkdir(values.workdir ?? positionals[0]);
  const exportDir = resolveExportDir(values.exportdir ?? positionals[1]);
  const explicitConfig = values.config ?? process.env['DB_ACCESS_MCP_CONFIG'];
  const explicitConfigPath =
    explicitConfig && explicitConfig.trim() !== '' ? path.resolve(expandTilde(explicitConfig.trim())) : undefined;
  const logLevel = parseLogLevel(values['log-level'] ?? process.env['DB_ACCESS_MCP_LOG_LEVEL']);
  const logger = new StderrLogger(logLevel);

  seedWorkdir(workdir, explicitConfigPath, logger);
  const { config, files } = loadMergedConfig(workdir, explicitConfigPath);
  const configService = new ConfigService(config);
  // Config env_files first, then CLI --env-file: later files take precedence
  // among themselves; the real environment always wins over any file.
  applyEnvFiles([...configService.envFiles, ...(values['env-file'] ?? [])], logger);
  logger.info('configuration loaded', {
    workdir,
    exportDir,
    files,
    connections: configService.connectionKeys().length,
    tunnels: Object.keys(configService.tunnels).length,
  });

  const { startServer } = await import('../server/bootstrap');
  await startServer({ workdir, exportDir, configService, logger });
}

main().catch((err: unknown) => {
  if (isDbAccessError(err)) {
    process.stderr.write(`db-access-mcp: [${err.code}] ${err.message}\n`);
    if (err.hint) process.stderr.write(`hint: ${err.hint}\n`);
  } else {
    process.stderr.write(`db-access-mcp: unexpected error: ${(err as Error)?.stack ?? String(err)}\n`);
  }
  process.exit(1);
});
