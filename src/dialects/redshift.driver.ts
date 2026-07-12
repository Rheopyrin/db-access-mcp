import { PostgresDriver } from './postgres.driver';

/**
 * Redshift speaks the postgres wire protocol (pg driver), with quirks:
 * - EXPLAIN supports neither FORMAT JSON nor ANALYZE cost semantics comparable to PG;
 * - default_transaction_read_only is not supported, so read_only is best-effort
 *   (use a read-only database user for real enforcement).
 */
export class RedshiftDriver extends PostgresDriver {
  override readonly dialect: string = 'redshift';
  override readonly explainFormat: 'json' | 'text' = 'text';

  override defaultPort(): number {
    return 5439;
  }

  protected override readonlyMode(): 'enforce' | 'best_effort' {
    return 'best_effort';
  }

  /** Extended-protocol cursors are unreliable on Redshift — exports use the buffered path. */
  protected override supportsStreaming(): boolean {
    return false;
  }

  override buildExplainSql(query: string): string {
    return `EXPLAIN ${query}`;
  }
}
