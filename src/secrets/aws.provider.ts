import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { DbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';
import type { ResolvedSecret, SecretProvider } from '../interfaces/secret-provider';
import type { AwsProfileResolver } from './aws-profile';

const awsSpecSchema = z
  .object({
    /** Secret name or full ARN. */
    secret_id: z.string().min(1),
    /** Named entry in "aws_secret_profiles"; omit for the default AWS SDK credential chain. */
    target: z.string().min(1).optional(),
    /** Specific version stage; defaults to AWSCURRENT. */
    version_stage: z.string().optional(),
  })
  .strict();

type AwsClient = Pick<SecretsManagerClient, 'send'>;
type ClientFactory = (region?: string, profile?: string) => AwsClient;

/**
 * AWS Secrets Manager provider. The secret value must be a JSON object
 * (SecretString); its keys become the `${aws.<key>}` placeholder namespace.
 * region/profile/reload come from the referenced aws_secret_profiles entry;
 * without "target" the default AWS SDK credential chain is used and the
 * secret is static (no reload).
 */
export class AwsSecretsManagerProvider implements SecretProvider {
  readonly name = 'aws';
  private readonly namedClients = new Map<string, AwsClient>();
  private defaultClient?: AwsClient;

  constructor(
    private readonly profiles: AwsProfileResolver,
    private readonly logger: Logger,
    private readonly clientFactory?: ClientFactory,
  ) {}

  async resolve(spec: unknown, connectionKey: string): Promise<ResolvedSecret> {
    const parsed = awsSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new DbAccessError(
        'CONFIG_INVALID',
        `connection "${connectionKey}": "secrets.aws" must be { secret_id, target?, version_stage? }`,
      );
    }
    const { secret_id, target, version_stage } = parsed.data;
    // Resolves env-refs and runs the profile's SSO bootstrap on EVERY call
    // (sessions expire; the client below stays cached).
    const profileInfo = await this.profiles.resolve(target);
    const { client, reloadIntervalMs } = this.getClient(target, profileInfo);

    let secretString: string | undefined;
    try {
      const response = await client.send(
        new GetSecretValueCommand({ SecretId: secret_id, ...(version_stage ? { VersionStage: version_stage } : {}) }),
      );
      secretString = response.SecretString;
    } catch (err) {
      throw new DbAccessError(
        'SECRET_RESOLUTION_FAILED',
        `connection "${connectionKey}": AWS Secrets Manager read failed for "${secret_id}"${target ? ` (profile "${target}")` : ''}: ${(err as Error).message}`,
        { hint: 'Check AWS credentials, the aws_secret_profiles entry and the secret id.', cause: err },
      );
    }
    if (secretString === undefined) {
      throw new DbAccessError(
        'SECRET_RESOLUTION_FAILED',
        `connection "${connectionKey}": secret "${secret_id}" has no SecretString (binary secrets are not supported)`,
      );
    }

    let data: Record<string, unknown>;
    try {
      const parsedJson: unknown = JSON.parse(secretString);
      if (parsedJson === null || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        throw new Error('not a JSON object');
      }
      data = parsedJson as Record<string, unknown>;
    } catch {
      throw new DbAccessError(
        'SECRET_RESOLUTION_FAILED',
        `connection "${connectionKey}": secret "${secret_id}" is not a JSON object`,
        { hint: 'Store the secret as a JSON object: {"username": "...", "password": "..."}.' },
      );
    }

    this.logger.debug('aws secret resolved', { connection: connectionKey, profile: target, reloadMs: reloadIntervalMs });
    return { data, ttlMs: reloadIntervalMs };
  }

  private getClient(
    target: string | undefined,
    profileInfo: { profile?: string; region?: string; reloadIntervalMs?: number },
  ): { client: AwsClient; reloadIntervalMs?: number } {
    if (target === undefined) {
      // Default AWS SDK credential chain (env, shared config, SSO, IMDS...).
      this.defaultClient ??= this.clientFactory ? this.clientFactory() : new SecretsManagerClient({});
      return { client: this.defaultClient };
    }

    let client = this.namedClients.get(target);
    if (!client) {
      const { region, profile } = profileInfo;
      client = this.clientFactory
        ? this.clientFactory(region, profile)
        : new SecretsManagerClient({ ...(region ? { region } : {}), ...(profile ? { profile } : {}) });
      this.namedClients.set(target, client);
    }
    return { client, reloadIntervalMs: profileInfo.reloadIntervalMs };
  }
}
