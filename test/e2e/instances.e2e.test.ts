import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startInstance } from './helpers';

const CONFIG = {
  connections: {
    db1: { type: 'postgres', options: { host: 'db.internal', port: 5432, database: 'd' } },
  },
};

function instanceFiles(workdir: string): string[] {
  const dir = path.join(workdir, 'instances');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}

describe('instance lifecycle and isolation', () => {
  it('creates an instance file on start and removes it on graceful shutdown', async () => {
    const instance = await startInstance(CONFIG);
    expect(instanceFiles(instance.workdir)).toHaveLength(1);
    await instance.close();
    // Give the shutdown hook a moment to delete the file.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && instanceFiles(instance.workdir).length > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(instanceFiles(instance.workdir)).toHaveLength(0);
  });

  it('two concurrent instances on one workdir register separately and do not interfere', async () => {
    const first = await startInstance(CONFIG);
    const second = await startInstance(CONFIG, { workdir: first.workdir });
    try {
      expect(instanceFiles(first.workdir)).toHaveLength(2);

      // Both instances answer tool calls independently.
      const [a, b] = await Promise.all([
        first.client.callTool({ name: 'connection_list', arguments: {} }),
        second.client.callTool({ name: 'connection_list', arguments: {} }),
      ]);
      expect((a.structuredContent as { connections: unknown[] }).connections).toHaveLength(1);
      expect((b.structuredContent as { connections: unknown[] }).connections).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('a new instance sweeps the stale registry file of a dead instance', async () => {
    const first = await startInstance(CONFIG);
    const workdir = first.workdir;
    await first.close();

    // Simulate a crash leftover: a registry file for a long-dead pid.
    const staleFile = path.join(workdir, 'instances', `999999-${Date.now() - 3_600_000}.json`);
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, JSON.stringify({ pid: 999999, startTimeMs: Date.now() - 3_600_000, tunnels: [] }));

    const second = await startInstance(CONFIG, { workdir });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && fs.existsSync(staleFile)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(fs.existsSync(staleFile)).toBe(false);
    } finally {
      await second.close();
    }
  });
});
