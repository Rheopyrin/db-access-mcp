import { ContainerModule } from 'inversify';
import type { ConfigService } from '../../config/config.service';
import type { Logger } from '../../interfaces/logger';
import type { QueryExecutor } from '../../pools/execute';
import type { PoolManager } from '../../pools/pool-manager';
import { ConnectionFindTool } from '../../server/tools/connection-find.tool';
import { ConnectionListTool } from '../../server/tools/connection-list.tool';
import { ConnectionTestTool } from '../../server/tools/connection-test.tool';
import { DialectListTool } from '../../server/tools/dialect-list.tool';
import { DownTunnelTool } from '../../server/tools/down-tunnel.tool';
import { QueryPlanTool } from '../../server/tools/query-plan.tool';
import { QueryToFileTool } from '../../server/tools/query-to-file.tool';
import { QueryTool } from '../../server/tools/query.tool';
import { TunnelListTool } from '../../server/tools/tunnel-list.tool';
import { UpTunnelTool } from '../../server/tools/up-tunnel.tool';
import type { SecretsManager } from '../../secrets/secrets-manager';
import type { TunnelManager } from '../../tunnels/tunnel-manager';
import type { DialectRegistry } from '../registries';
import { TYPES } from '../types';

export function toolsModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) => new DialectListTool(ctx.get<DialectRegistry>(TYPES.DialectRegistry), ctx.get<Logger>(TYPES.Logger)),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) =>
          new ConnectionListTool(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<DialectRegistry>(TYPES.DialectRegistry),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) =>
          new ConnectionFindTool(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<DialectRegistry>(TYPES.DialectRegistry),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) =>
          new ConnectionTestTool(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<DialectRegistry>(TYPES.DialectRegistry),
            ctx.get<QueryExecutor>(TYPES.QueryExecutor),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) =>
          new QueryTool(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<QueryExecutor>(TYPES.QueryExecutor),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) =>
          new QueryToFileTool(
            ctx.get<string>(TYPES.ExportDir),
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<QueryExecutor>(TYPES.QueryExecutor),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) =>
          new QueryPlanTool(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<DialectRegistry>(TYPES.DialectRegistry),
            ctx.get<QueryExecutor>(TYPES.QueryExecutor),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) =>
          new UpTunnelTool(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<DialectRegistry>(TYPES.DialectRegistry),
            ctx.get<SecretsManager>(TYPES.SecretsManager),
            ctx.get<TunnelManager>(TYPES.TunnelManager),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) =>
          new DownTunnelTool(
            ctx.get<TunnelManager>(TYPES.TunnelManager),
            ctx.get<PoolManager>(TYPES.PoolManager),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.McpTool)
      .toDynamicValue(
        (ctx) => new TunnelListTool(ctx.get<TunnelManager>(TYPES.TunnelManager), ctx.get<Logger>(TYPES.Logger)),
      )
      .inSingletonScope();
  });
}
