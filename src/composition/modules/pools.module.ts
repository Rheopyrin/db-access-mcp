import { ContainerModule } from 'inversify';
import type { ConfigService } from '../../config/config.service';
import type { Logger } from '../../interfaces/logger';
import { QueryExecutor } from '../../pools/execute';
import { PoolManager } from '../../pools/pool-manager';
import type { SecretsManager } from '../../secrets/secrets-manager';
import type { DialectRegistry } from '../registries';
import { TYPES } from '../types';

export function poolsModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(TYPES.PoolManager)
      .toDynamicValue(
        (ctx) =>
          new PoolManager(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<DialectRegistry>(TYPES.DialectRegistry),
            ctx.get<SecretsManager>(TYPES.SecretsManager),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.QueryExecutor)
      .toDynamicValue(
        (ctx) =>
          new QueryExecutor({
            configService: ctx.get<ConfigService>(TYPES.ConfigService),
            dialects: ctx.get<DialectRegistry>(TYPES.DialectRegistry),
            poolManager: ctx.get<PoolManager>(TYPES.PoolManager),
            secretsManager: ctx.get<SecretsManager>(TYPES.SecretsManager),
            logger: ctx.get<Logger>(TYPES.Logger),
          }),
      )
      .inSingletonScope();
  });
}
