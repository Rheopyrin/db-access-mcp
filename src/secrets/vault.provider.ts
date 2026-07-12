import { z } from 'zod';
import { DbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';
import type { ResolvedSecret, SecretProvider } from '../interfaces/secret-provider';
import type { VaultClient, VaultClientManager } from './vault-clients';

const vaultSpecSchema = z
  .object({
    /** Named entry in the "vault" config section; omit for the env-based default client. */
    target: z.string().min(1).optional(),
    /** Full API path, e.g. "secret/data/databases/db4" for KV v2. */
    path: z.string().min(1),
  })
  .strict();

/**
 * HashiCorp Vault provider. KV v2 responses are unwrapped so placeholders
 * resolve against the secret payload itself; dynamic secrets (e.g. database
 * credentials engine) carry lease_id/lease_duration which SecretsManager uses
 * for auto-refresh before expiry.
 */
export class VaultSecretProvider implements SecretProvider {
  readonly name = 'vault';

  constructor(
    private readonly clients: VaultClientManager,
    private readonly logger: Logger,
  ) {}

  private parseSpec(spec: unknown, connectionKey: string): { target?: string; path: string } {
    const parsed = vaultSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new DbAccessError(
        'CONFIG_INVALID',
        `connection "${connectionKey}": "secrets.vault" must be { path, target? }`,
      );
    }
    return parsed.data;
  }

  async resolve(spec: unknown, connectionKey: string): Promise<ResolvedSecret> {
    const { target, path } = this.parseSpec(spec, connectionKey);
    const client = this.clients.getClient(target, connectionKey);
    let response: Awaited<ReturnType<VaultClient['read']>>;
    try {
      response = await client.read(path);
    } catch (err) {
      throw new DbAccessError(
        'SECRET_RESOLUTION_FAILED',
        `connection "${connectionKey}": vault read failed for "${path}"${target ? ` (vault "${target}")` : ''}: ${(err as Error).message}`,
        {
          hint: target
            ? `Check the "vault.${target}" settings and the secret path.`
            : 'Check VAULT_ADDR/VAULT_TOKEN and the secret path.',
          cause: err,
        },
      );
    }

    const raw = response.data ?? {};
    // KV v2 wraps the payload: { data: {...}, metadata: {...} }.
    const isKv2 =
      typeof raw['data'] === 'object' && raw['data'] !== null && typeof raw['metadata'] === 'object' && raw['metadata'] !== null;
    const data = (isKv2 ? raw['data'] : raw) as Record<string, unknown>;

    const leaseDuration = typeof response.lease_duration === 'number' ? response.lease_duration : 0;
    return {
      data,
      ttlMs: leaseDuration > 0 ? leaseDuration * 1_000 : undefined,
      leaseId: response.lease_id !== undefined && response.lease_id !== '' ? response.lease_id : undefined,
    };
  }

  /** Lease renewal fast path: extends the lease without changing the secret data. */
  async renew(current: ResolvedSecret, spec: unknown, connectionKey: string): Promise<ResolvedSecret> {
    if (!current.leaseId) throw new Error('renew called without a leaseId');
    const { target } = this.parseSpec(spec, connectionKey);
    const client = this.clients.getClient(target, connectionKey);
    const response = await client.write('sys/leases/renew', { lease_id: current.leaseId });
    const leaseDuration = typeof response.lease_duration === 'number' ? response.lease_duration : 0;
    this.logger.debug('vault lease renewed', { connection: connectionKey, leaseDurationS: leaseDuration });
    return {
      ...current,
      ttlMs: leaseDuration > 0 ? leaseDuration * 1_000 : current.ttlMs,
    };
  }
}
