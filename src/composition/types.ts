/** DI tokens. Multi-bound tokens (many implementations) are marked accordingly. */
export const TYPES = {
  Logger: Symbol.for('db-access-mcp.Logger'),
  /** Workdir (config.json, conf.d/, instances/, sso/). */
  Workdir: Symbol.for('db-access-mcp.Workdir'),
  /** Export dir: where query_to_file writes exports. */
  ExportDir: Symbol.for('db-access-mcp.ExportDir'),
  ConfigService: Symbol.for('db-access-mcp.ConfigService'),

  /** multi-bound: one per dialect */
  DialectDriver: Symbol.for('db-access-mcp.DialectDriver'),
  DialectRegistry: Symbol.for('db-access-mcp.DialectRegistry'),

  /** multi-bound: one per secret provider */
  SecretProvider: Symbol.for('db-access-mcp.SecretProvider'),
  SecretProviderRegistry: Symbol.for('db-access-mcp.SecretProviderRegistry'),
  SecretsManager: Symbol.for('db-access-mcp.SecretsManager'),
  VaultClientManager: Symbol.for('db-access-mcp.VaultClientManager'),
  AwsProfileResolver: Symbol.for('db-access-mcp.AwsProfileResolver'),

  /** multi-bound: one per tunnel type */
  TunnelProvider: Symbol.for('db-access-mcp.TunnelProvider'),
  TunnelProviderRegistry: Symbol.for('db-access-mcp.TunnelProviderRegistry'),
  TunnelManager: Symbol.for('db-access-mcp.TunnelManager'),
  SsoSessionManager: Symbol.for('db-access-mcp.SsoSessionManager'),

  PoolManager: Symbol.for('db-access-mcp.PoolManager'),
  QueryExecutor: Symbol.for('db-access-mcp.QueryExecutor'),
  InstanceRegistry: Symbol.for('db-access-mcp.InstanceRegistry'),

  /** multi-bound: one per MCP tool */
  McpTool: Symbol.for('db-access-mcp.McpTool'),
} as const;
