import { ContainerModule } from 'inversify';
import type { ConfigService } from '../../config/config.service';
import type { Logger } from '../../interfaces/logger';
import type { SecretProvider } from '../../interfaces/secret-provider';
import { AwsIamSecretProvider } from '../../secrets/aws-iam.provider';
import { AwsProfileResolver } from '../../secrets/aws-profile';
import { AwsRedshiftCredsProvider } from '../../secrets/aws-redshift-creds.provider';
import { AwsSecretsManagerProvider } from '../../secrets/aws.provider';
import { EnvSecretProvider } from '../../secrets/env.provider';
import type { SsoSessionManager } from '../../tunnels/sso-session';
import { SecretsManager } from '../../secrets/secrets-manager';
import { VaultClientManager } from '../../secrets/vault-clients';
import { VaultSecretProvider } from '../../secrets/vault.provider';
import { SecretProviderRegistry } from '../registries';
import { TYPES } from '../types';

export function secretsModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(TYPES.VaultClientManager)
      .toDynamicValue((ctx) => new VaultClientManager(ctx.get<ConfigService>(TYPES.ConfigService)))
      .inSingletonScope();

    bind(TYPES.AwsProfileResolver)
      .toDynamicValue(
        (ctx) =>
          new AwsProfileResolver(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<SsoSessionManager>(TYPES.SsoSessionManager),
          ),
      )
      .inSingletonScope();

    // Register additional secret providers here (one binding line each).
    bind(TYPES.SecretProvider).toDynamicValue(() => new EnvSecretProvider()).inSingletonScope();
    bind(TYPES.SecretProvider)
      .toDynamicValue(
        (ctx) =>
          new VaultSecretProvider(ctx.get<VaultClientManager>(TYPES.VaultClientManager), ctx.get<Logger>(TYPES.Logger)),
      )
      .inSingletonScope();
    bind(TYPES.SecretProvider)
      .toDynamicValue(
        (ctx) =>
          new AwsSecretsManagerProvider(
            ctx.get<AwsProfileResolver>(TYPES.AwsProfileResolver),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();
    bind(TYPES.SecretProvider)
      .toDynamicValue(
        (ctx) =>
          new AwsIamSecretProvider(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<AwsProfileResolver>(TYPES.AwsProfileResolver),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();
    bind(TYPES.SecretProvider)
      .toDynamicValue(
        (ctx) =>
          new AwsRedshiftCredsProvider(
            ctx.get<AwsProfileResolver>(TYPES.AwsProfileResolver),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();

    bind(TYPES.SecretProviderRegistry)
      .toDynamicValue((ctx) => new SecretProviderRegistry(ctx.getAll<SecretProvider>(TYPES.SecretProvider)))
      .inSingletonScope();

    bind(TYPES.SecretsManager)
      .toDynamicValue(
        (ctx) =>
          new SecretsManager(
            ctx.get<ConfigService>(TYPES.ConfigService),
            ctx.get<SecretProviderRegistry>(TYPES.SecretProviderRegistry),
            ctx.get<Logger>(TYPES.Logger),
          ),
      )
      .inSingletonScope();
  });
}
