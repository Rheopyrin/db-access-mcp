import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startInstance, type E2eInstance } from './helpers';

const CONFIG = {
  connections: {
    'pg-main': {
      type: 'postgres',
      description: 'Main DB',
      read_only: true,
      metadata: { team: 'growth', prod: true },
      options: { host: 'db.internal', port: 5432, database: 'analytics', user: 'u', password: 'never-show' },
    },
    'mysql-app': {
      type: 'mysql',
      metadata: { team: 'app' },
      options: { host: 'mysql.internal', port: 3306, database: 'appdb', user: 'u', password: 'never-show' },
    },
    'pg-secret': {
      type: 'postgres',
      options: { host: 'h2', port: 5432, database: 'd2', user: '${env.user}', password: '${env.password}' },
      secrets: { env: { user: 'E2E_DB_USER', password: 'E2E_DB_PASSWORD' } },
    },
    'pg-unreachable': {
      type: 'postgres',
      // Discard port on localhost: connection refused immediately (fast test).
      options: { host: '127.0.0.1', port: 9, database: 'd', user: 'u', password: 'p', connectionTimeoutMillis: 500 },
      pool: { connection_timeout_ms: 500 },
    },
    'pg-multidb': {
      type: 'postgres',
      metadata: { team: 'multi' },
      options: { host: 'multi.internal', port: 5432, databases: ['alpha', 'beta'], user: 'u', password: 'never-show' },
    },
  },
};

describe('MCP tools over stdio', () => {
  let instance: E2eInstance;

  beforeAll(async () => {
    instance = await startInstance(CONFIG);
  });

  afterAll(async () => {
    await instance?.close();
  });

  it('lists the expected tools', async () => {
    const { tools } = await instance.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'connection_list',
        'connection_find',
        'connection_test',
        'dialect_list',
        'down_tunnel',
        'query',
        'query_plan',
        'query_to_file',
        'tunnel_list',
        'up_tunnel',
      ]),
    );
  });

  it('multi-database connection: listed with databases, findable by member, query demands the parameter', async () => {
    const list = await instance.client.callTool({ name: 'connection_list', arguments: {} });
    const multidb = (list.structuredContent as { connections: { key: string; databases?: string[] }[] }).connections.find(
      (c) => c.key === 'pg-multidb',
    );
    expect(multidb?.databases).toEqual(['alpha', 'beta']);

    const found = await instance.client.callTool({ name: 'connection_find', arguments: { database: 'beta' } });
    expect((found.structuredContent as { connections: { key: string }[] }).connections.map((c) => c.key)).toEqual([
      'pg-multidb',
    ]);

    const noDb = await instance.client.callTool({
      name: 'query',
      arguments: { connection: 'pg-multidb', query: 'SELECT 1' },
    });
    expect(noDb.isError).toBe(true);
    const text = (noDb.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('DATABASE_NOT_FOUND');
    expect(text).toContain('alpha, beta');

    const wrongDb = await instance.client.callTool({
      name: 'query',
      arguments: { connection: 'pg-multidb', database: 'gamma', query: 'SELECT 1' },
    });
    expect(wrongDb.isError).toBe(true);
    expect(((wrongDb.content as { text: string }[])[0]?.text ?? '')).toContain('gamma');
  });

  it('connection_test reports ok=false with the failure code for an unreachable database', async () => {
    const result = await instance.client.callTool({ name: 'connection_test', arguments: { connection: 'pg-unreachable' } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      ok: boolean;
      connection: string;
      error?: { code: string; message: string };
    };
    expect(structured.ok).toBe(false);
    expect(structured.connection).toBe('pg-unreachable');
    expect(structured.error?.code).toBe('CONNECTION_FAILED');
  }, 30_000);

  it('connection_test with an unknown connection is a tool error', async () => {
    const result = await instance.client.callTool({ name: 'connection_test', arguments: { connection: 'nope' } });
    expect(result.isError).toBe(true);
  });

  it('tunnel_list returns an empty list when nothing is open', async () => {
    const result = await instance.client.callTool({ name: 'tunnel_list', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ tunnels: [] });
  });

  it('down_tunnel with an unknown id returns TUNNEL_FAILED with a hint', async () => {
    const result = await instance.client.callTool({ name: 'down_tunnel', arguments: { tunnel_id: 'tun_deadbeef' } });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('TUNNEL_FAILED');
    expect(text).toContain('up_tunnel');
  });

  it('up_tunnel input schema exposes the optional local_port', async () => {
    const { tools } = await instance.client.listTools();
    const upTunnel = tools.find((t) => t.name === 'up_tunnel');
    const properties = (upTunnel?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['connection', 'local_port']));
  });

  it('dialect_list returns all supported dialects with ports and explain formats', async () => {
    const result = await instance.client.callTool({ name: 'dialect_list', arguments: {} });
    const structured = result.structuredContent as {
      dialects: { dialect: string; default_port: number; explain_format: string }[];
    };
    const byName = Object.fromEntries(structured.dialects.map((d) => [d.dialect, d]));
    expect(Object.keys(byName).sort()).toEqual(['mssql', 'mysql', 'postgres', 'redshift']);
    expect(byName['postgres']).toEqual({ dialect: 'postgres', default_port: 5432, explain_format: 'json' });
    expect(byName['mysql']).toEqual({ dialect: 'mysql', default_port: 3306, explain_format: 'json' });
    expect(byName['redshift']).toEqual({ dialect: 'redshift', default_port: 5439, explain_format: 'text' });
    expect(byName['mssql']).toEqual({ dialect: 'mssql', default_port: 1433, explain_format: 'text' });
  });

  it('connection_list returns sanitized connections without credentials', async () => {
    const result = await instance.client.callTool({ name: 'connection_list', arguments: {} });
    const structured = result.structuredContent as { connections: Record<string, unknown>[] };
    expect(structured.connections).toHaveLength(5);
    const pg = structured.connections.find((c) => c['key'] === 'pg-main')!;
    expect(pg).toMatchObject({
      type: 'postgres',
      read_only: true,
      host: 'db.internal',
      port: 5432,
      database: 'analytics',
      metadata: { team: 'growth', prod: true },
    });
    const text = JSON.stringify(result.content);
    expect(text).not.toContain('never-show');
    expect(text).not.toContain('"user"');
  });

  it('connection_find applies AND filters including metadata and ignores user/password', async () => {
    const result = await instance.client.callTool({
      name: 'connection_find',
      arguments: { type: 'postgres', metadata: { team: 'growth' }, user: 'ignored', password: 'ignored' },
    });
    const structured = result.structuredContent as { connections: { key: string }[]; note?: string };
    expect(structured.connections.map((c) => c.key)).toEqual(['pg-main']);
    expect(structured.note).toMatch(/ignored filter/);
  });

  it('connection_find with no matches returns an empty list', async () => {
    const result = await instance.client.callTool({
      name: 'connection_find',
      arguments: { type: 'postgres', metadata: { team: 'growth', prod: false } },
    });
    const structured = result.structuredContent as { connections: unknown[] };
    expect(structured.connections).toEqual([]);
  });

  it('query against an unknown connection returns a structured error', async () => {
    const result = await instance.client.callTool({
      name: 'query',
      arguments: { connection: 'nope', query: 'SELECT 1' },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { code: string };
    expect(structured.code).toBe('CONNECTION_NOT_FOUND');
  });

  it('query against an unreachable database returns CONNECTION_FAILED after retries', async () => {
    const result = await instance.client.callTool({
      name: 'query',
      arguments: { connection: 'pg-main', query: 'SELECT 1', timeout_ms: 1000 },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { code: string };
    expect(structured.code).toBe('CONNECTION_FAILED');
  }, 60_000);

  it('missing env secret surfaces SECRET_RESOLUTION_FAILED with variable names', async () => {
    const result = await instance.client.callTool({
      name: 'query',
      arguments: { connection: 'pg-secret', query: 'SELECT 1' },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { code: string; message: string };
    expect(structured.code).toBe('SECRET_RESOLUTION_FAILED');
    expect(structured.message).toContain('E2E_DB_USER');
  });
});
