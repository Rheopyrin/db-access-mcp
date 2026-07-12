import { Container } from 'inversify';
import type { ConfigService } from '../config/config.service';
import type { Logger } from '../interfaces/logger';
import { coreModule } from './modules/core.module';
import { dialectsModule } from './modules/dialects.module';
import { poolsModule } from './modules/pools.module';
import { secretsModule } from './modules/secrets.module';
import { toolsModule } from './modules/tools.module';
import { tunnelsModule } from './modules/tunnels.module';

export interface ContainerOptions {
  /** Workdir: config.json, conf.d/, instances/, sso/. */
  workdir: string;
  /** Export dir: where query_to_file writes exports. */
  exportDir: string;
  configService: ConfigService;
  logger: Logger;
}

export function buildContainer(options: ContainerOptions): Container {
  const container = new Container({ defaultScope: 'Singleton' });
  container.load(
    coreModule(options),
    secretsModule(),
    dialectsModule(),
    tunnelsModule(),
    poolsModule(),
    toolsModule(),
  );
  return container;
}
