import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_PATH = path.join(repoRoot, 'dist', 'cli.js');

export interface E2eInstance {
  client: Client;
  workdir: string;
  close(): Promise<void>;
}

/** Spawns the built CLI with a temp config dir + config and connects an MCP client. */
export async function startInstance(
  config: Record<string, unknown>,
  opts: { env?: Record<string, string>; workdir?: string } = {},
): Promise<E2eInstance> {
  const workdir = opts.workdir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'db-access-mcp-e2e-'));
  fs.mkdirSync(workdir, { recursive: true });
  const configPath = path.join(workdir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, '--workdir', workdir, '--log-level', 'error'],
    env: { ...(process.env as Record<string, string>), ...opts.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    workdir,
    close: async () => {
      await client.close();
    },
  };
}
