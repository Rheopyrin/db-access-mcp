import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstance, type E2eInstance } from './helpers';

function conn(host: string): Record<string, unknown> {
  return { type: 'postgres', options: { host, port: 5432, database: 'd', user: 'u', password: 'p' } };
}

describe('config v2 e2e: conf.d merge and env files', () => {
  let instance: E2eInstance;

  beforeAll(async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-access-mcp-e2e-'));
    const confD = path.join(workdir, 'conf.d');
    fs.mkdirSync(confD, { recursive: true });

    // Split config: base sections in config.json, extra connections and a
    // named vault in conf.d files, an env-ref connection fed by an env file.
    fs.writeFileSync(path.join(confD, '10-vaults.json'), JSON.stringify({
      vault: { 'vault-main': { address: 'https://vault.example.com:8200', token: 't' } },
    }));
    fs.writeFileSync(path.join(confD, '20-more-connections.json'), JSON.stringify({
      connections: {
        'from-confd': conn('confd.example.com'),
        'env-secrets': {
          type: 'postgres',
          options: { host: 'h', port: 5432, database: 'd', user: '${env.user}', password: '${env.password}' },
          secrets: { env: { user: 'E2E_CFGV2_USER', password: 'E2E_CFGV2_PASSWORD' } },
        },
      },
    }));
    const envFile = path.join(workdir, 'extra.env');
    fs.writeFileSync(envFile, 'E2E_CFGV2_USER=file-user\nE2E_CFGV2_PASSWORD=file-pass\n');

    instance = await startInstance(
      {
        env_files: [envFile],
        connections: { 'from-config': conn('main.example.com') },
      },
      { workdir },
    );
  });

  afterAll(async () => {
    await instance?.close();
  });

  it('connection_list sees connections merged from config.json and conf.d', async () => {
    const result = await instance.client.callTool({ name: 'connection_list', arguments: {} });
    const structured = result.structuredContent as { connections: { key: string }[] };
    const keys = structured.connections.map((c) => c.key).sort();
    expect(keys).toEqual(['env-secrets', 'from-confd', 'from-config']);
  });

  it('connection_find matches across files', async () => {
    const result = await instance.client.callTool({
      name: 'connection_find',
      arguments: { host: 'confd.example.com' },
    });
    const structured = result.structuredContent as { connections: { key: string }[] };
    expect(structured.connections.map((c) => c.key)).toEqual(['from-confd']);
  });

  it('duplicate connection keys across files fail startup', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-access-mcp-e2e-'));
    fs.mkdirSync(path.join(workdir, 'conf.d'), { recursive: true });
    fs.writeFileSync(path.join(workdir, 'conf.d', 'dup.json'), JSON.stringify({ connections: { same: conn('b') } }));
    await expect(
      startInstance({ connections: { same: conn('a') } }, { workdir }),
    ).rejects.toThrow();
  });
});
