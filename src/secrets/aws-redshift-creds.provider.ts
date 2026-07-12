import { GetClusterCredentialsCommand, RedshiftClient } from '@aws-sdk/client-redshift';
import { z } from 'zod';
import { DbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';
import type { ResolvedSecret, SecretProvider } from '../interfaces/secret-provider';
import type { AwsProfileResolver } from './aws-profile';

const specSchema = z
  .object({
    /** Redshift cluster identifier (not the hostname). */
    cluster_id: z.string().min(1),
    /** Database user the temporary credentials are issued for. */
    db_user: z.string().min(1),
    /** aws_secret_profiles entry (profile/region/sso); omit for the default chain. */
    target: z.string().min(1).optional(),
    duration_seconds: z.number().int().min(900).max(3_600).default(3_600),
  })
  .strict();

type RedshiftClientLike = Pick<RedshiftClient, 'send'>;
type ClientFactory = (region?: string, profile?: string) => RedshiftClientLike;

/**
 * Temporary Redshift credentials via redshift:GetClusterCredentials.
 * Placeholders: ${aws_redshift_creds.username} / ${aws_redshift_creds.password}.
 * The returned username carries the "IAM:" prefix and must be sent to the
 * server as-is (the pg driver does). Refresh reuses the standard 80%-TTL
 * pipeline with atomic pool swaps.
 */
export class AwsRedshiftCredsProvider implements SecretProvider {
  readonly name = 'aws_redshift_creds';
  private readonly clients = new Map<string, RedshiftClientLike>();

  constructor(
    private readonly profiles: AwsProfileResolver,
    private readonly logger: Logger,
    private readonly clientFactory?: ClientFactory,
  ) {}

  async resolve(spec: unknown, connectionKey: string): Promise<ResolvedSecret> {
    const parsed = specSchema.safeParse(spec);
    if (!parsed.success) {
      throw new DbAccessError(
        'CONFIG_INVALID',
        `connection "${connectionKey}": "secrets.aws_redshift_creds" must be { cluster_id, db_user, target?, duration_seconds? }`,
      );
    }
    const { cluster_id, db_user, target, duration_seconds } = parsed.data;

    // Env-refs + the profile's SSO bootstrap on every resolution.
    const profileInfo = await this.profiles.resolve(target);
    const cacheKey = target ?? '';
    let client = this.clients.get(cacheKey);
    if (!client) {
      client = this.clientFactory
        ? this.clientFactory(profileInfo.region, profileInfo.profile)
        : new RedshiftClient({
            ...(profileInfo.region ? { region: profileInfo.region } : {}),
            ...(profileInfo.profile ? { profile: profileInfo.profile } : {}),
          });
      this.clients.set(cacheKey, client);
    }

    let response: { DbUser?: string; DbPassword?: string; Expiration?: Date };
    try {
      response = await client.send(
        new GetClusterCredentialsCommand({
          ClusterIdentifier: cluster_id,
          DbUser: db_user,
          DurationSeconds: duration_seconds,
        }),
      );
    } catch (err) {
      throw new DbAccessError(
        'SECRET_RESOLUTION_FAILED',
        `connection "${connectionKey}": GetClusterCredentials failed for cluster "${cluster_id}": ${(err as Error).message}`,
        {
          hint: 'Check the redshift:GetClusterCredentials IAM policy, the cluster identifier and the db user.',
          cause: err,
        },
      );
    }
    if (!response.DbUser || !response.DbPassword) {
      throw new DbAccessError(
        'SECRET_RESOLUTION_FAILED',
        `connection "${connectionKey}": GetClusterCredentials returned no credentials for cluster "${cluster_id}"`,
      );
    }

    const ttlMs =
      response.Expiration instanceof Date
        ? Math.max(60_000, response.Expiration.getTime() - Date.now())
        : duration_seconds * 1_000;
    this.logger.debug('redshift temporary credentials issued', {
      connection: connectionKey,
      cluster: cluster_id,
      ttlMs,
    });
    // DbUser keeps its "IAM:" prefix — the server expects it verbatim.
    return { data: { username: response.DbUser, password: response.DbPassword }, ttlMs };
  }
}
