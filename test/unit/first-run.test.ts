import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config.service';
import { EXAMPLE_CONFIG } from '../../src/config/example-config';
import { seedWorkdir } from '../../src/config/first-run';
import { StderrLogger } from '../../src/logging/logger';

const logger = new StderrLogger('silent');

describe('seedWorkdir (first run)', () => {
  it('creates the workdir, conf.d, an example config and an empty default config', () => {
    const workdir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-')), 'nested', 'wd');
    seedWorkdir(workdir, undefined, logger);

    expect(fs.existsSync(path.join(workdir, 'config.example.json'))).toBe(true);
    expect(fs.statSync(path.join(workdir, 'conf.d')).isDirectory()).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(workdir, 'config.json'), 'utf8'));
    expect(config).toEqual({ connections: {} });
  });

  it('does not create config.json for explicit --config paths or when conf.d already has configs', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-'));
    seedWorkdir(workdir, path.join(workdir, 'custom.json'), logger);
    expect(fs.existsSync(path.join(workdir, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(workdir, 'config.example.json'))).toBe(true);

    fs.writeFileSync(path.join(workdir, 'conf.d', 'conns.json'), '{"connections":{}}');
    seedWorkdir(workdir, undefined, logger);
    expect(fs.existsSync(path.join(workdir, 'config.json'))).toBe(false);
  });

  it('does not overwrite an existing config.json', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-'));
    const defaultConfig = path.join(workdir, 'config.json');
    fs.writeFileSync(defaultConfig, '{"connections":{"x":{"type":"postgres","options":{}}}}');
    seedWorkdir(workdir, undefined, logger);
    expect(JSON.parse(fs.readFileSync(defaultConfig, 'utf8')).connections).toHaveProperty('x');
  });

  it('the example config passes schema validation', () => {
    expect(() => parseConfig(JSON.parse(JSON.stringify(EXAMPLE_CONFIG)))).not.toThrow();
  });

  it('the example config covers all supported dialects and secret providers', () => {
    const types = new Set(Object.values(EXAMPLE_CONFIG.connections).map((c) => c.type));
    expect([...types].sort()).toEqual(['mssql', 'mysql', 'postgres', 'redshift']);
    const providers = new Set(
      Object.values(EXAMPLE_CONFIG.connections)
        .flatMap((c) => ('secrets' in c && c.secrets ? Object.keys(c.secrets) : [])),
    );
    expect([...providers].sort()).toEqual(['aws', 'aws_iam', 'aws_redshift_creds', 'env', 'vault']);
  });
});
