import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../interfaces/logger';
import { exampleConfigJson } from './example-config';
import { CONF_D_DIR } from './loader';
import { CONFIG_FILE_NAME, ensureDir } from './paths';

export const EXAMPLE_FILE_NAME = 'config.example.json';

function confDHasConfigs(workdir: string): boolean {
  try {
    return fs
      .readdirSync(path.join(workdir, CONF_D_DIR))
      .some((name) => name.endsWith('.json') && !name.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * First-run experience: the workdir always exists after start, always carries a
 * full config.example.json and a conf.d/ directory. When the default config
 * discovery is used (no --config) and neither config.json nor conf.d/*.json
 * exist, a minimal valid config.json is created so the server starts cleanly
 * with zero connections instead of failing.
 */
export function seedWorkdir(workdir: string, explicitConfigPath: string | undefined, logger: Logger): void {
  ensureDir(workdir);
  ensureDir(path.join(workdir, CONF_D_DIR));

  const examplePath = path.join(workdir, EXAMPLE_FILE_NAME);
  if (!fs.existsSync(examplePath)) {
    fs.writeFileSync(examplePath, exampleConfigJson());
    logger.info('wrote example configuration', { file: examplePath });
  }

  const defaultConfigPath = path.join(workdir, CONFIG_FILE_NAME);
  if (explicitConfigPath === undefined && !fs.existsSync(defaultConfigPath) && !confDHasConfigs(workdir)) {
    fs.writeFileSync(defaultConfigPath, `${JSON.stringify({ connections: {} }, null, 2)}\n`);
    logger.warn('no config found; created an empty one — add your connections', {
      config: defaultConfigPath,
      example: examplePath,
    });
  }
}
