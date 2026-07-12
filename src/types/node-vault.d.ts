/** Minimal typings for node-vault (the package ships without TypeScript types). */
declare module 'node-vault' {
  interface VaultOptions {
    apiVersion?: string;
    endpoint?: string;
    token?: string;
    namespace?: string;
    [key: string]: unknown;
  }

  interface VaultResponse {
    data?: Record<string, unknown>;
    lease_id?: string;
    lease_duration?: number;
    renewable?: boolean;
    [key: string]: unknown;
  }

  interface VaultClient {
    read(path: string): Promise<VaultResponse>;
    write(path: string, data?: Record<string, unknown>): Promise<VaultResponse>;
  }

  function nodeVault(options?: VaultOptions): VaultClient;
  export = nodeVault;
}
