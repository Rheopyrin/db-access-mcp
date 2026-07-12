import { ContainerModule } from 'inversify';
import type { ContainerOptions } from '../container';
import { TYPES } from '../types';

export function coreModule(options: ContainerOptions): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(TYPES.Logger).toConstantValue(options.logger);
    bind(TYPES.Workdir).toConstantValue(options.workdir);
    bind(TYPES.ExportDir).toConstantValue(options.exportDir);
    bind(TYPES.ConfigService).toConstantValue(options.configService);
  });
}
