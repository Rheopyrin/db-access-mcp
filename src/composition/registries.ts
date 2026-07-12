import { DbAccessError } from '../errors';
import type { DialectDriver } from '../interfaces/dialect-driver';
import type { SecretProvider } from '../interfaces/secret-provider';
import type { TunnelProvider } from '../interfaces/tunnel-provider';

/**
 * Indexes multi-bound implementations by their discriminator.
 * Duplicate discriminators fail at container build time.
 */
export class KeyedRegistry<T> {
  private readonly byKey = new Map<string, T>();

  constructor(
    private readonly kind: string,
    items: readonly T[],
    keyOf: (item: T) => string,
  ) {
    for (const item of items) {
      const key = keyOf(item);
      if (this.byKey.has(key)) {
        throw new Error(`duplicate ${kind} registered: "${key}"`);
      }
      this.byKey.set(key, item);
    }
  }

  get(key: string): T {
    const item = this.byKey.get(key);
    if (!item) {
      throw new DbAccessError(
        'CONFIG_INVALID',
        `unknown ${this.kind} "${key}" (available: ${[...this.byKey.keys()].join(', ') || 'none'})`,
      );
    }
    return item;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  keys(): string[] {
    return [...this.byKey.keys()];
  }
}

export class DialectRegistry extends KeyedRegistry<DialectDriver> {
  constructor(drivers: readonly DialectDriver[]) {
    super('dialect', drivers, (d) => d.dialect);
  }
}

export class SecretProviderRegistry extends KeyedRegistry<SecretProvider> {
  constructor(providers: readonly SecretProvider[]) {
    super('secret provider', providers, (p) => p.name);
  }
}

export class TunnelProviderRegistry extends KeyedRegistry<TunnelProvider> {
  constructor(providers: readonly TunnelProvider[]) {
    super('tunnel provider', providers, (p) => p.type);
  }
}
