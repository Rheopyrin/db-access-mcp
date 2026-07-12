import { z } from 'zod';

const metadataValue = z.union([z.string(), z.number(), z.boolean()]);

/**
 * A config value that is either an inline string or a reference to an
 * environment variable: "..." | { "env": "ENV_VAR_NAME" }.
 * Resolved lazily at point of use (see src/config/env-ref.ts) so a missing
 * variable only fails the connections that actually need it.
 */
const envRefSchema = z.object({ env: z.string().min(1) }).strict();
export const envRefStringSchema = z.union([z.string(), envRefSchema]);
export type EnvRefString = z.infer<typeof envRefStringSchema>;

export const poolSettingsSchema = z
  .object({
    max: z.number().int().positive().optional(),
    min: z.number().int().nonnegative().optional(),
    idle_timeout_ms: z.number().int().nonnegative().optional(),
    connection_timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

export const limitsSchema = z
  .object({
    max_rows: z.number().int().positive().max(100_000).optional(),
    query_timeout_ms: z.number().int().min(100).max(600_000).optional(),
    idle_close_ms: z.number().int().min(1_000).optional(),
  })
  .strict();

const sshTunnelOptionsSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535).default(22),
    username: z.string().optional(),
    password: z.string().optional(),
    /** Path to a private key file; `~` is expanded. */
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
    /** true = platform default agent, or an explicit agent socket/pipe path. */
    agent: z.union([z.boolean(), z.string()]).optional(),
    ready_timeout_ms: z.number().int().positive().optional(),
    /**
     * Host-key verification (defends against MITM on the bastion).
     * - host_key_sha256: pin the server key by its SHA-256 fingerprint
     *   (base64, the `ssh-keygen -lf` value with or without the "SHA256:" prefix);
     * - known_hosts: path to a known_hosts file (default ~/.ssh/known_hosts);
     * - strict_host_key: set false to accept any key (INSECURE — opt-out only).
     */
    host_key_sha256: z.string().min(1).optional(),
    known_hosts: z.string().min(1).optional(),
    strict_host_key: z.boolean().default(true),
  })
  .strict();

const ssmTunnelOptionsSchema = z
  .object({
    /** AWS instance ID of the bastion, e.g. i-0123456789abcdef0. */
    target: z.string().min(1),
    region: z.string().optional(),
    profile: z.string().optional(),
    document_name: z.string().optional(),
  })
  .strict();

/**
 * AWS SSO bootstrap: verified (sts get-caller-identity) before the tunnel
 * opens; a missing/expired session triggers `aws sso login` and the tunnel
 * waits until the session is ready or timeout_ms elapses. The session is
 * never closed by this server.
 */
const ssoSchema = z
  .object({
    /** sso-session name: login runs `aws sso login --sso-session <name>` (preferred). */
    session: z.string().min(1).optional(),
    /**
     * AWS profile: used for the sts liveness check, and for login
     * (`aws sso login --profile`) when no `session` is set.
     * Default: the tunnel's options.profile.
     */
    profile: z.string().min(1).optional(),
    timeout_ms: z.number().int().min(10_000).max(1_800_000).default(300_000),
  })
  .strict();

export const tunnelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ssh'), options: sshTunnelOptionsSchema }).strict(),
  z.object({ type: z.literal('ssm'), options: ssmTunnelOptionsSchema, sso: ssoSchema.optional() }).strict(),
]);

export type SsoSettings = z.infer<typeof ssoSchema>;

const tunnelRefSchema = z
  .object({
    target: z.string().min(1),
    localPort: z.number().int().min(1_024).max(65_535).optional(),
  })
  .strict();

/**
 * Exactly one secret provider per connection: { "<provider>": <provider-specific spec> }.
 * Provider names and spec shapes are validated by the SecretProvider implementations,
 * keeping the schema open for future providers.
 */
const secretsSchema = z
  .record(z.unknown())
  .refine((obj) => Object.keys(obj).length === 1, {
    message: 'exactly one secret provider must be configured per connection',
  });

export const connectionSchema = z
  .object({
    type: z.string().min(1),
    description: z.string().optional(),
    read_only: z.boolean().default(false),
    metadata: z.record(metadataValue).default({}),
    /** Driver passthrough options (pg / mysql2), may contain ${provider.path} placeholders. */
    options: z.record(z.unknown()),
    pool: poolSettingsSchema.optional(),
    limits: limitsSchema.optional(),
    tunnel: tunnelRefSchema.optional(),
    secrets: secretsSchema.optional(),
  })
  .strict();

/**
 * One named Vault server. Extra keys are passed through to node-vault.
 * The implicit default client (used when a secret spec has no "target") is
 * built purely from VAULT_ADDR/VAULT_TOKEN env vars and never lives in this
 * map — a user-defined entry named "default" is just a regular entry.
 */
export const vaultSettingsSchema = z
  .object({
    address: envRefStringSchema.optional(),
    token: envRefStringSchema.optional(),
    namespace: envRefStringSchema.optional(),
  })
  .passthrough();

export const awsSecretProfileSchema = z
  .object({
    aws_profile: envRefStringSchema.optional(),
    aws_region: envRefStringSchema.optional(),
    /** AWS Secrets Manager has no leases: reloading is opt-in per profile. */
    reload_interval_ms: z.number().int().min(10_000).optional(),
    /**
     * Same SSO bootstrap as ssm tunnels: verified before credentials are used
     * by any provider referencing this profile (aws, aws_iam,
     * aws_redshift_creds); sso.profile defaults to aws_profile.
     */
    sso: ssoSchema.optional(),
  })
  .strict();

export const configSchema = z
  .object({
    /** Named Vault servers: { "<name>": { address, token, ... } }. */
    vault: z.record(vaultSettingsSchema).default({}),
    /** Named AWS Secrets Manager profiles referenced by secrets.aws.target. */
    aws_secret_profiles: z.record(awsSecretProfileSchema).default({}),
    /** Extra .env files applied at startup (real environment always wins). */
    env_files: z.array(z.string().min(1)).default([]),
    /**
     * Additional roots query_to_file may write under (besides the export dir).
     * Absolute or `~`-prefixed; every path below a listed root is writable.
     */
    allow_export_paths: z.array(z.string().min(1)).default([]),
    tunnels: z.record(tunnelSchema).default({}),
    pool: poolSettingsSchema.default({}),
    limits: limitsSchema.default({}),
    connections: z.record(connectionSchema).default({}),
  })
  .strict();

export type PoolSettings = z.infer<typeof poolSettingsSchema>;
export type Limits = z.infer<typeof limitsSchema>;
export type TunnelConfig = z.infer<typeof tunnelSchema>;
export type TunnelRef = z.infer<typeof tunnelRefSchema>;
export type ConnectionConfig = z.infer<typeof connectionSchema>;
export type VaultSettings = z.infer<typeof vaultSettingsSchema>;
export type AwsSecretProfile = z.infer<typeof awsSecretProfileSchema>;
export type Config = z.infer<typeof configSchema>;

export const DEFAULT_POOL: Required<PoolSettings> = {
  max: 5,
  min: 0,
  idle_timeout_ms: 30_000,
  connection_timeout_ms: 10_000,
};

export const DEFAULT_LIMITS: Required<Limits> = {
  max_rows: 1_000,
  query_timeout_ms: 30_000,
  idle_close_ms: 600_000,
};
