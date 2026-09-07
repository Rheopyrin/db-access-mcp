import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import type { DialectRegistry } from '../../composition/registries';
import type { ConfigService } from '../../config/config.service';
import { applyEnvFiles } from '../../config/env-files';
import { loadMergedConfig } from '../../config/loader';
import { diffConfigs, type SectionDiff } from '../../config/reload';
import { DbAccessError } from '../../errors';
import type { Logger } from '../../interfaces/logger';
import type { McpTool } from '../../interfaces/mcp-tool';
import type { PoolManager } from '../../pools/pool-manager';
import type { SecretsManager } from '../../secrets/secrets-manager';
import type { TunnelManager } from '../../tunnels/tunnel-manager';
import { errorResult, okResult } from '../results';

type OpenPool = ReturnType<PoolManager['openEntries']>[number];

function sectionPayload(diff: SectionDiff): Record<string, unknown> {
  return {
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    unchanged: diff.unchanged.length,
  };
}

/**
 * Re-reads the configuration files into the running server. Deliberately
 * NON-DISRUPTIVE: open pools and running tunnels are never closed, recreated
 * or reconfigured — the new definitions only apply to what is created after
 * the reload. Anything live whose definition changed or disappeared is
 * reported as a warning instead.
 */
export class ConfigReloadTool implements McpTool {
  readonly name = 'config_reload';
  readonly description =
    'Re-read the configuration files (config.json + conf.d/*.json, or --config <file>) into the running ' +
    'server, so connections and tunnels added or edited on disk become usable WITHOUT a restart. ' +
    'Open pools and running tunnels are never touched: they keep their previous definition until they are ' +
    'closed (idle timeout, down_tunnel, shutdown) and are reported in "warnings". Returns the files that ' +
    'were read plus the connections/tunnels added, removed and changed. On an invalid config nothing is ' +
    'swapped — the server keeps running on the previous configuration and the validation errors are returned.';
  readonly inputSchema: ZodRawShape = {};

  constructor(
    private readonly configService: ConfigService,
    private readonly dialects: DialectRegistry,
    private readonly poolManager: PoolManager,
    private readonly secretsManager: SecretsManager,
    private readonly tunnelManager: TunnelManager,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<CallToolResult> {
    try {
      const source = this.configService.configSource;
      if (!source) {
        throw new DbAccessError('CONFIG_INVALID', 'this server was not started from configuration files', {
          hint: 'config_reload is only available when the configuration was loaded from a workdir or --config file.',
        });
      }

      // Everything below up to replace() is validation: any throw leaves the
      // active configuration exactly as it was.
      const { config: next, files } = loadMergedConfig(source.workdir, source.explicitConfigPath);
      // Same fail-fast check the server does at startup, so an unusable dialect
      // is rejected here rather than on the first query.
      for (const [key, conn] of Object.entries(next.connections)) {
        if (!this.dialects.has(conn.type)) {
          throw new DbAccessError(
            'CONFIG_INVALID',
            `connection "${key}": unknown type "${conn.type}" (available: ${this.dialects.keys().join(', ')})`,
          );
        }
      }
      // Config env_files first, then CLI --env-file — the startup precedence.
      applyEnvFiles([...next.env_files, ...source.envFileArgs], this.logger);

      const previous = this.configService.snapshot;
      const diff = diffConfigs(previous, next);
      this.configService.replace(next, files);

      // One snapshot of the live state, read (never mutated) by both steps.
      const openPools = this.poolManager.openEntries();
      const warnings = this.warnLiveState(diff.connections, diff.tunnels, openPools);
      this.dropStaleSecrets(diff.connections, openPools);

      this.logger.info('configuration reloaded', {
        files,
        added: diff.connections.added.length,
        removed: diff.connections.removed.length,
        changed: diff.connections.changed.length,
        warnings: warnings.length,
      });

      return okResult({
        reloaded: true,
        workdir: source.workdir,
        files,
        connections: sectionPayload(diff.connections),
        tunnels: sectionPayload(diff.tunnels),
        pool_defaults_changed: diff.poolDefaultsChanged,
        limits_changed: diff.limitsChanged,
        env_files_changed: diff.envFilesChanged,
        warnings,
      });
    } catch (err) {
      return errorResult(err, this.logger, this.name);
    }
  }

  /**
   * Describes the live runtime state that the reload deliberately left alone.
   * Read-only: it inspects pools and tunnels, it never changes them.
   */
  private warnLiveState(connections: SectionDiff, tunnels: SectionDiff, openPools: OpenPool[]): string[] {
    const warnings: string[] = [];
    const liveTunnels = this.tunnelManager.liveTunnels();

    for (const key of [...connections.changed, ...connections.removed]) {
      const databases = openPools.filter((e) => e.connectionKey === key).map((e) => e.database ?? '(default)');
      const pinned = liveTunnels.some((t) => t.connections.includes(key));
      if (databases.length === 0 && !pinned) continue;
      const verb = connections.removed.includes(key) ? 'was removed from the config' : 'changed';
      const held =
        databases.length > 0
          ? `${databases.length} open pool(s) (databases: ${databases.join(', ')})`
          : 'an open tunnel';
      warnings.push(
        `connection "${key}" ${verb} but still has ${held}: the live state is untouched and keeps the previous ` +
          'definition until it is closed (idle timeout, down_tunnel force or server exit).',
      );
    }

    for (const name of [...tunnels.changed, ...tunnels.removed]) {
      for (const live of liveTunnels.filter((t) => t.tunnelName === name)) {
        const verb = tunnels.removed.includes(name) ? 'was removed from the config' : 'changed';
        warnings.push(
          `tunnel "${name}" ${verb} but is currently open (${live.id}): it stays up with its previous definition ` +
            'until it is closed (down_tunnel or server exit); the new definition applies to the next tunnel opened.',
        );
      }
    }

    return warnings;
  }

  /**
   * Drops cached secrets of connections whose definition changed or vanished,
   * so the next pool resolves them from the new definition. Connections with
   * open pools are skipped on purpose: their cache entry carries the lease
   * refresh timer that keeps those live pools' credentials rotating.
   */
  private dropStaleSecrets(connections: SectionDiff, openPools: OpenPool[]): void {
    for (const key of [...connections.changed, ...connections.removed]) {
      if (openPools.some((e) => e.connectionKey === key)) continue;
      this.secretsManager.invalidate(key);
    }
  }
}
