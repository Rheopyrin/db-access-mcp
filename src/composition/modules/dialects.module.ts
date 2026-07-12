import { ContainerModule } from 'inversify';
import { MssqlDriver } from '../../dialects/mssql.driver';
import { MysqlDriver } from '../../dialects/mysql.driver';
import { PostgresDriver } from '../../dialects/postgres.driver';
import { RedshiftDriver } from '../../dialects/redshift.driver';
import type { DialectDriver } from '../../interfaces/dialect-driver';
import type { Logger } from '../../interfaces/logger';
import { DialectRegistry } from '../registries';
import { TYPES } from '../types';

export function dialectsModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    // Register additional dialects here (one binding line each).
    bind(TYPES.DialectDriver)
      .toDynamicValue((ctx) => new PostgresDriver(ctx.get<Logger>(TYPES.Logger)))
      .inSingletonScope();
    bind(TYPES.DialectDriver)
      .toDynamicValue((ctx) => new RedshiftDriver(ctx.get<Logger>(TYPES.Logger)))
      .inSingletonScope();
    bind(TYPES.DialectDriver)
      .toDynamicValue((ctx) => new MysqlDriver(ctx.get<Logger>(TYPES.Logger)))
      .inSingletonScope();
    bind(TYPES.DialectDriver)
      .toDynamicValue((ctx) => new MssqlDriver(ctx.get<Logger>(TYPES.Logger)))
      .inSingletonScope();

    bind(TYPES.DialectRegistry)
      .toDynamicValue((ctx) => new DialectRegistry(ctx.getAll<DialectDriver>(TYPES.DialectDriver)))
      .inSingletonScope();
  });
}
