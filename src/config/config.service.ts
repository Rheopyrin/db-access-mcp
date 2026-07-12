import { type z } from 'zod';
import { DbAccessError } from '../errors';
import { collectPlaceholders } from '../secrets/placeholders';
import {
  configSchema,
  DEFAULT_LIMITS,
  DEFAULT_POOL,
  type AwsSecretProfile,
  type Config,
  type ConnectionConfig,
  type Limits,
  type PoolSettings,
  type TunnelConfig,
  type VaultSettings,
} from './schema';

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
}

function secretTarget(spec: unknown): string | undefined {
  if (spec !== null && typeof spec === 'object' && 'target' in spec) {
    const target = (spec as { target?: unknown }).target;
    if (typeof target === 'string') return target;
  }
  return undefined;
}

/**
 * Validates config semantics that the zod schema cannot express: tunnel
 * references, secret placeholder namespaces and vault/aws target references.
 */
function validateDatabases(key: string, options: Record<string, unknown>): void {
  const hasConnectionString = typeof options['connectionString'] === 'string' || typeof options['uri'] === 'string';
  const database = options['database'];
  const databases = options['databases'];

  if (databases !== undefined && databases !== null) {
    if (hasConnectionString) {
      throw new DbAccessError(
        'CONFIG_INVALID',
        `connection "${key}": "databases" cannot be combined with connectionString/uri — declare host/port/database as discrete options`,
      );
    }
    if (!Array.isArray(databases) || databases.some((d) => typeof d !== 'string' || d === '')) {
      throw new DbAccessError('CONFIG_INVALID', `connection "${key}": "databases" must be an array of non-empty strings`);
    }
    if (new Set(databases).size !== databases.length) {
      throw new DbAccessError('CONFIG_INVALID', `connection "${key}": "databases" contains duplicates`);
    }
  }

  // Every connection must declare its database(s); connectionString/uri
  // connections carry the database inside the string.
  const hasSingle = typeof database === 'string' && database !== '';
  const hasList = Array.isArray(databases) && databases.length > 0;
  if (!hasConnectionString && !hasSingle && !hasList) {
    throw new DbAccessError(
      'CONFIG_INVALID',
      `connection "${key}": declare "database" and/or a non-empty "databases" list in options`,
    );
  }

  // Multi-statement is opt-in and must be an explicit boolean; a stray string
  // would otherwise be silently treated as "off".
  const multi = options['multipleStatements'];
  if (multi !== undefined && typeof multi !== 'boolean') {
    throw new DbAccessError('CONFIG_INVALID', `connection "${key}": options.multipleStatements must be a boolean`);
  }
}

export function validateConfigSemantics(config: Config): void {
  for (const [key, conn] of Object.entries(config.connections)) {
    if (conn.tunnel && !(conn.tunnel.target in config.tunnels)) {
      throw new DbAccessError(
        'CONFIG_INVALID',
        `connection "${key}": tunnel target "${conn.tunnel.target}" is not defined in "tunnels"`,
      );
    }

    validateDatabases(key, conn.options);

    const providerName = conn.secrets ? Object.keys(conn.secrets)[0] : undefined;
    if (conn.secrets && providerName) {
      const target = secretTarget(conn.secrets[providerName]);
      if (target !== undefined) {
        if (providerName === 'vault' && !(target in config.vault)) {
          throw new DbAccessError(
            'CONFIG_INVALID',
            `connection "${key}": secrets.vault.target "${target}" is not defined in "vault"`,
          );
        }
        if (
          ['aws', 'aws_iam', 'aws_redshift_creds'].includes(providerName) &&
          !(target in config.aws_secret_profiles)
        ) {
          throw new DbAccessError(
            'CONFIG_INVALID',
            `connection "${key}": secrets.${providerName}.target "${target}" is not defined in "aws_secret_profiles"`,
          );
        }
      }
    }
    const placeholders = collectPlaceholders(conn.options);
    for (const ph of placeholders) {
      if (!providerName) {
        throw new DbAccessError(
          'CONFIG_INVALID',
          `connection "${key}": options contain placeholder ${ph.raw} but no "secrets" provider is configured`,
        );
      }
      if (ph.provider !== providerName) {
        throw new DbAccessError(
          'CONFIG_INVALID',
          `connection "${key}": placeholder ${ph.raw} uses namespace "${ph.provider}" but the configured secret provider is "${providerName}"`,
        );
      }
    }
  }
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new DbAccessError('CONFIG_INVALID', `invalid configuration:\n${formatZodIssues(result.error)}`);
  }
  validateConfigSemantics(result.data);
  return result.data;
}

export class ConfigService {
  constructor(private readonly config: Config) {}

  /** Named Vault servers; the implicit env-based default is NOT in this map. */
  get vaultConfigs(): Record<string, VaultSettings> {
    return this.config.vault;
  }

  getVaultConfig(name: string): VaultSettings {
    const settings = this.config.vault[name];
    if (!settings) {
      throw new DbAccessError('CONFIG_INVALID', `vault "${name}" is not defined in "vault"`);
    }
    return settings;
  }

  get awsSecretProfiles(): Record<string, AwsSecretProfile> {
    return this.config.aws_secret_profiles;
  }

  getAwsSecretProfile(name: string): AwsSecretProfile {
    const profile = this.config.aws_secret_profiles[name];
    if (!profile) {
      throw new DbAccessError('CONFIG_INVALID', `aws secret profile "${name}" is not defined in "aws_secret_profiles"`);
    }
    return profile;
  }

  get envFiles(): string[] {
    return this.config.env_files;
  }

  /** Extra roots query_to_file may write under, besides the export dir. */
  get allowExportPaths(): string[] {
    return this.config.allow_export_paths;
  }

  get tunnels(): Record<string, TunnelConfig> {
    return this.config.tunnels;
  }

  connectionKeys(): string[] {
    return Object.keys(this.config.connections);
  }

  findConnection(key: string): ConnectionConfig | undefined {
    return this.config.connections[key];
  }

  getConnection(key: string): ConnectionConfig {
    const conn = this.config.connections[key];
    if (!conn) {
      throw new DbAccessError('CONNECTION_NOT_FOUND', `connection "${key}" is not configured`, {
        hint: 'Use the connection_list tool to see configured connections.',
      });
    }
    return conn;
  }

  getTunnelConfig(name: string): TunnelConfig {
    const tunnel = this.config.tunnels[name];
    if (!tunnel) {
      throw new DbAccessError('CONFIG_INVALID', `tunnel "${name}" is not defined in "tunnels"`);
    }
    return tunnel;
  }

  effectiveLimits(key: string): Required<Limits> {
    const conn = this.getConnection(key);
    return { ...DEFAULT_LIMITS, ...this.config.limits, ...conn.limits };
  }

  effectivePool(key: string): Required<PoolSettings> {
    const conn = this.getConnection(key);
    return { ...DEFAULT_POOL, ...this.config.pool, ...conn.pool };
  }

  /** Provider name + provider-specific spec, or undefined when the connection has no secrets. */
  secretSpec(key: string): { provider: string; spec: unknown } | undefined {
    const conn = this.getConnection(key);
    if (!conn.secrets) return undefined;
    const provider = Object.keys(conn.secrets)[0] as string;
    return { provider, spec: (conn.secrets)[provider] };
  }
}
