import fs from 'node:fs';
import path from 'node:path';
import { DbAccessError } from '../errors';
import { parseConfig } from './config.service';
import { CONFIG_FILE_NAME } from './paths';
import type { Config } from './schema';

export const CONF_D_DIR = 'conf.d';

/** Sections merged as named records: keys are unioned, duplicates are an error. */
const RECORD_SECTIONS = ['vault', 'aws_secret_profiles', 'tunnels', 'connections'] as const;
/** Sections that may appear in at most one file. */
const SCALAR_SECTIONS = ['pool', 'limits', 'env_files', 'allow_export_paths'] as const;

interface RawFile {
  file: string;
  data: Record<string, unknown>;
}

function readJsonFile(file: string): RawFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new DbAccessError('CONFIG_INVALID', `cannot read config file ${file}`, {
      hint: 'Create the config file or pass --config <path>. See config.example.json in the workdir.',
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new DbAccessError('CONFIG_INVALID', `config file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DbAccessError('CONFIG_INVALID', `config file ${file} must contain a JSON object`);
  }
  return { file, data: parsed as Record<string, unknown> };
}

function listConfDFiles(workdir: string): string[] {
  const dir = path.join(workdir, CONF_D_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no conf.d directory — fine
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

export function mergeRawConfigs(files: RawFile[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const recordEntrySource = new Map<string, string>(); // "<section>:<key>" -> file
  const scalarSource = new Map<string, string>(); // section -> file

  for (const { file, data } of files) {
    for (const [section, value] of Object.entries(data)) {
      if ((RECORD_SECTIONS as readonly string[]).includes(section)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new DbAccessError('CONFIG_INVALID', `${file}: section "${section}" must be a JSON object`);
        }
        const target = (merged[section] ??= {}) as Record<string, unknown>;
        for (const [key, entry] of Object.entries(value)) {
          const sourceKey = `${section}:${key}`;
          const previous = recordEntrySource.get(sourceKey);
          if (previous) {
            throw new DbAccessError(
              'CONFIG_INVALID',
              `${section} "${key}" is defined in both ${previous} and ${file}`,
              { hint: 'Named entries are merged across config files; every name must be unique.' },
            );
          }
          recordEntrySource.set(sourceKey, file);
          target[key] = entry;
        }
      } else if ((SCALAR_SECTIONS as readonly string[]).includes(section)) {
        const previous = scalarSource.get(section);
        if (previous) {
          throw new DbAccessError(
            'CONFIG_INVALID',
            `section "${section}" is defined in both ${previous} and ${file}`,
            { hint: `"${section}" may appear in at most one config file.` },
          );
        }
        scalarSource.set(section, file);
        merged[section] = value;
      } else {
        // Unknown top-level keys are kept so the strict zod schema rejects
        // them with a per-key error message.
        merged[section] = value;
      }
    }
  }
  return merged;
}

export interface LoadedConfig {
  config: Config;
  /** Absolute paths of the files that contributed, in load order. */
  files: string[];
}

/**
 * Loads the configuration. With an explicit --config path only that file is
 * read; otherwise <workdir>/config.json (when present) plus every
 * <workdir>/conf.d/*.json (sorted, non-recursive, dotfiles ignored) are merged.
 */
export function loadMergedConfig(workdir: string, explicitConfigPath?: string): LoadedConfig {
  if (explicitConfigPath) {
    const raw = readJsonFile(explicitConfigPath);
    return { config: parseConfig(raw.data), files: [explicitConfigPath] };
  }

  const files: string[] = [];
  const defaultConfig = path.join(workdir, CONFIG_FILE_NAME);
  if (fs.existsSync(defaultConfig)) files.push(defaultConfig);
  files.push(...listConfDFiles(workdir));

  if (files.length === 0) {
    throw new DbAccessError('CONFIG_INVALID', `no configuration found in ${workdir}`, {
      hint: `Create ${defaultConfig} or ${path.join(workdir, CONF_D_DIR)}/*.json. See config.example.json in the workdir.`,
    });
  }

  const merged = mergeRawConfigs(files.map(readJsonFile));
  return { config: parseConfig(merged), files };
}
