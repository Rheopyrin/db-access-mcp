import { ContainerModule } from 'inversify';
import type { ConfigService } from '../../config/config.service';
import type { Logger } from '../../interfaces/logger';
import type { TunnelProvider } from '../../interfaces/tunnel-provider';
import { SshTunnelProvider } from '../../tunnels/ssh.provider';
import { SsmTunnelProvider } from '../../tunnels/ssm.provider';
import { SsoSessionManager } from '../../tunnels/sso-session';
import { TunnelManager } from '../../tunnels/tunnel-manager';
import { TunnelProviderRegistry } from '../registries';
import { TYPES } from '../types';

export function tunnelsModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(TYPES.SsoSessionManager)
      .toDynamicValue((ctx) => new SsoSessionManager(ctx.get<string>(TYPES.Workdir), ctx.get<Logger>(TYPES.Logger)))
      .inSingletonScope();

    // Register additional tunnel types here (one binding line each).
    bind(TYPES.TunnelProvider)
      .toDynamicValue((ctx) => new SshTunnelProvider(ctx.get<Logger>(TYPES.Logger)))
      .inSingletonScope();
    bind(TYPES.TunnelProvider)
      .toDynamicValue(
        (ctx) =>
          new SsmTunnelProvider(ctx.get<Logger>(TYPES.Logger), ctx.get<SsoSessionManager>(TYPES.SsoSessionManager)),
      )
      .inSingletonScope();

    bind(TYPES.TunnelProviderRegistry)
      .toDynamicValue((ctx) => new TunnelProviderRegistry(ctx.getAll<TunnelProvider>(TYPES.TunnelProvider)))
      .inSingletonScope();

    bind(TYPES.TunnelManager)
      .toDynamicValue(
        (ctx) =>
          new TunnelManager(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<TunnelProviderRegistry>(TYPES.TunnelProviderRegistry),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();
  });
}
