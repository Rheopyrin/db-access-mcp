import { describe, expect, it } from 'vitest';
import { DialectRegistry } from '../../src/composition/registries';
import { ConfigService, parseConfig } from '../../src/config/config.service';
import { PostgresDriver } from '../../src/dialects/postgres.driver';
import { StderrLogger } from '../../src/logging/logger';
import { summarizeConnection } from '../../src/server/sanitize';
import { ConnectionFindTool } from '../../src/server/tools/connection-find.tool';

const logger = new StderrLogger('silent');
const dialects = new DialectRegistry([new PostgresDriver(logger)]);

const configService = new ConfigService(
  parseConfig({
    connections: {
      single: {
        type: 'postgres',
        options: { host: 'h1', port: 5432, database: 'main', user: 'u', password: 'never' },
      },
      multi: {
        type: 'postgres',
        options: { host: 'h2', port: 5432, databases: ['alpha', 'beta'], user: 'u', password: 'never' },
      },
    },
  }),
);

describe('summarizeConnection with databases', () => {
  it('exposes the databases list and never credentials', () => {
    const summary = summarizeConnection('multi', configService.getConnection('multi'), dialects);
    expect(summary.databases).toEqual(['alpha', 'beta']);
    expect(summary.database).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain('never');
  });

  it('omits databases for single-database connections', () => {
    const summary = summarizeConnection('single', configService.getConnection('single'), dialects);
    expect(summary.database).toBe('main');
    expect(summary.databases).toBeUndefined();
  });
});

describe('connection_find database filter with databases', () => {
  const tool = new ConnectionFindTool(configService, dialects, logger);

  async function findKeys(args: Record<string, unknown>): Promise<string[]> {
    const result = await tool.execute(args);
    const structured = result.structuredContent as { connections: { key: string }[] };
    return structured.connections.map((c) => c.key);
  }

  it('matches by the single database property', async () => {
    expect(await findKeys({ database: 'main' })).toEqual(['single']);
  });

  it('matches members of the databases list (OR semantics)', async () => {
    expect(await findKeys({ database: 'beta' })).toEqual(['multi']);
    expect(await findKeys({ database: 'alpha' })).toEqual(['multi']);
  });

  it('returns nothing for unknown databases', async () => {
    expect(await findKeys({ database: 'ghost' })).toEqual([]);
  });
});
