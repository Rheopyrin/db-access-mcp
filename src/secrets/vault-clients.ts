import nodeVault from 'node-vault';
import type { ConfigService } from '../config/config.service';
import { resolveEnvRef } from '../config/env-ref';
import { DbAccessError } from '../errors';

export type VaultClient = Pick<ReturnType<typeof nodeVault>, 'read' | 'write'>;
export type VaultClientFactory = (target: string | undefined) => VaultClient;

/**
 * Creates and caches node-vault clients for the named "vault" config entries.
 *
 * The implicit default client (no "target" in the secret spec) is built purely
 * from the standard node-vault environment variables (VAULT_ADDR/VAULT_TOKEN)
 * and is cached in a separate field — a user-defined entry named "default" is
 * an ordinary named entry and never collides with it.
 */
export class VaultClientManager {
  private readonly named = new Map<string, VaultClient>();
  private defaultClient?: VaultClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly clientFactory?: VaultClientFactory,
  ) {}

  getClient(target: string | undefined, connectionKey: string): VaultClient {
    if (target === undefined) return this.getDefaultClient(connectionKey);

    let client = this.named.get(target);
    if (!client) {
      client = this.clientFactory ? this.clientFactory(target) : this.buildNamedClient(target);
      this.named.set(target, client);
    }
    return client;
  }

  private getDefaultClient(connectionKey: string): VaultClient {
    if (!this.defaultClient) {
      if (this.clientFactory) {
        this.defaultClient = this.clientFactory(undefined);
        return this.defaultClient;
      }
      const endpoint = process.env['VAULT_ADDR'];
      if (!endpoint) {
        throw new DbAccessError(
          'CONFIG_INVALID',
          `connection "${connectionKey}" uses vault secrets without "target" but VAULT_ADDR is not set`,
          { hint: 'Set VAULT_ADDR/VAULT_TOKEN, or add a named entry to "vault" and reference it via "target".' },
        );
      }
      this.defaultClient = nodeVault({
        apiVersion: 'v1',
        endpoint,
        token: process.env['VAULT_TOKEN'],
        ...(process.env['VAULT_NAMESPACE'] ? { namespace: process.env['VAULT_NAMESPACE'] } : {}),
      });
    }
    return this.defaultClient;
  }

  private buildNamedClient(target: string): VaultClient {
    // Existence is validated at config load; this throws only for internal misuse.
    const settings = this.configService.getVaultConfig(target);
    const { address, token, namespace, ...extra } = settings;
    const endpoint = resolveEnvRef(address, `vault "${target}" address`);
    if (!endpoint) {
      throw new DbAccessError('CONFIG_INVALID', `vault "${target}" has no address configured`);
    }
    return nodeVault({
      apiVersion: 'v1',
      endpoint,
      token: resolveEnvRef(token, `vault "${target}" token`),
      ...(namespace !== undefined ? { namespace: resolveEnvRef(namespace, `vault "${target}" namespace`) } : {}),
      ...extra,
    });
  }
}
