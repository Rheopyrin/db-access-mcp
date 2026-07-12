export interface ResolvedSecret {
  /** Parsed secret object; placeholder dot-paths resolve against it. */
  data: Record<string, unknown>;
  /** Lease/TTL in ms; undefined or 0 means static (never refreshed). */
  ttlMs?: number;
  /** Renewable lease id (Vault). */
  leaseId?: string;
}

export interface SecretProvider {
  /** Matches both the config key under "secrets" and the placeholder namespace. */
  readonly name: string;
  resolve(spec: unknown, connectionKey: string): Promise<ResolvedSecret>;
  /** Optional lease-renewal fast path; falls back to resolve() when absent. */
  renew?(current: ResolvedSecret, spec: unknown, connectionKey: string): Promise<ResolvedSecret>;
}
