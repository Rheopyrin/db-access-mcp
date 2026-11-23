import type { SsmDiscoverSettings } from '../config/schema';
import { DbAccessError } from '../errors';
import type { Logger } from '../interfaces/logger';
import { type AwsCliRunner, defaultAwsCliRunner } from './aws-cli';

export interface AwsContext {
  region?: string;
  profile?: string;
}

export interface DiscoveredInstance {
  instanceId: string;
  name?: string;
  launchTime?: string;
}

export interface ResolvedTarget extends DiscoveredInstance {
  fromCache: boolean;
  /** Number of running instances matched by the EC2 filters. */
  matched: number;
}

interface CacheEntry {
  value: DiscoveredInstance & { matched: number };
  expiresAt: number;
}

function asList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** `Name=<name>,Values=<v1>,<v2>` — the shorthand form the aws CLI accepts for --filters. */
function filterArg(name: string, values: string[]): string {
  // Commas inside a value would split it; the JSON form of the shorthand avoids that.
  if (values.some((v) => v.includes(','))) {
    return JSON.stringify({ Name: name, Values: values });
  }
  return `Name=${name},Values=${values.join(',')}`;
}

/** EC2 filters for a discover spec; `instance-state-name=running` is always added. */
export function buildEc2Filters(spec: SsmDiscoverSettings): string[] {
  const filters: string[] = [filterArg('instance-state-name', ['running'])];
  for (const [key, value] of Object.entries(spec.tags)) {
    filters.push(filterArg(`tag:${key}`, asList(value)));
  }
  if (spec.vpc_id !== undefined) filters.push(filterArg('vpc-id', asList(spec.vpc_id)));
  if (spec.subnet_id !== undefined) filters.push(filterArg('subnet-id', asList(spec.subnet_id)));
  if (spec.security_group_id !== undefined) {
    filters.push(filterArg('instance.group-id', asList(spec.security_group_id)));
  }
  for (const [key, value] of Object.entries(spec.filters)) {
    filters.push(filterArg(key, asList(value)));
  }
  return filters;
}

function contextArgs(ctx: AwsContext): string[] {
  return [...(ctx.region ? ['--region', ctx.region] : []), ...(ctx.profile ? ['--profile', ctx.profile] : [])];
}

function describeSpec(spec: SsmDiscoverSettings): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(spec.tags)) parts.push(`tag:${k}=${asList(v).join('|')}`);
  if (spec.vpc_id) parts.push(`vpc-id=${asList(spec.vpc_id).join('|')}`);
  if (spec.subnet_id) parts.push(`subnet-id=${asList(spec.subnet_id).join('|')}`);
  if (spec.security_group_id) parts.push(`group-id=${asList(spec.security_group_id).join('|')}`);
  for (const [k, v] of Object.entries(spec.filters)) parts.push(`${k}=${asList(v).join('|')}`);
  return parts.join(', ');
}

function parseInstances(raw: unknown): DiscoveredInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveredInstance[] = [];
  for (const item of raw as unknown[]) {
    const r = item as { id?: unknown; launch?: unknown; name?: unknown } | null;
    if (!r || typeof r.id !== 'string') continue;
    out.push({
      instanceId: r.id,
      launchTime: typeof r.launch === 'string' ? r.launch : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
    });
  }
  return out;
}

function launchMs(i: DiscoveredInstance): number {
  const t = i.launchTime ? Date.parse(i.launchTime) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function summary(list: DiscoveredInstance[]): string {
  return list.map((i) => `${i.instanceId}${i.name ? ` (${i.name})` : ''}`).join(', ');
}

/**
 * Resolves an ssm tunnel's `discover` spec to one EC2 instance id via the aws
 * CLI (read-only calls: ec2 describe-instances, ssm describe-instance-information).
 * Results are cached per tunnel for `cache_ttl_ms`; concurrent lookups for the
 * same tunnel share one call. `invalidate` drops the cache after a failed open
 * so a recreated bastion is found on the next attempt.
 */
export class SsmTargetResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<DiscoveredInstance & { matched: number }>>();

  constructor(
    private readonly logger: Logger,
    private readonly aws: AwsCliRunner = defaultAwsCliRunner(),
    private readonly now: () => number = Date.now,
  ) {}

  private key(tunnelName: string, spec: SsmDiscoverSettings, ctx: AwsContext): string {
    return `${tunnelName}|${JSON.stringify({ spec, region: ctx.region, profile: ctx.profile })}`;
  }

  /** The cached (non-expired) result, without any AWS call. */
  peek(tunnelName: string, spec: SsmDiscoverSettings, ctx: AwsContext): ResolvedTarget | undefined {
    const hit = this.cache.get(this.key(tunnelName, spec, ctx));
    return hit && hit.expiresAt > this.now() ? { ...hit.value, fromCache: true } : undefined;
  }

  invalidate(tunnelName: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${tunnelName}|`)) this.cache.delete(key);
    }
  }

  async resolve(
    tunnelName: string,
    spec: SsmDiscoverSettings,
    ctx: AwsContext,
    opts: { fresh?: boolean } = {},
  ): Promise<ResolvedTarget> {
    const key = this.key(tunnelName, spec, ctx);
    if (!opts.fresh) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > this.now()) return { ...hit.value, fromCache: true };
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.lookup(tunnelName, spec, ctx).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const value = await pending;
    if (spec.cache_ttl_ms > 0) this.cache.set(key, { value, expiresAt: this.now() + spec.cache_ttl_ms });
    return { ...value, fromCache: false };
  }

  private fail(tunnelName: string, message: string, hint?: string, cause?: unknown): never {
    throw new DbAccessError('TUNNEL_FAILED', `tunnel "${tunnelName}": ${message}`, { hint, cause });
  }

  private async lookup(
    tunnelName: string,
    spec: SsmDiscoverSettings,
    ctx: AwsContext,
  ): Promise<DiscoveredInstance & { matched: number }> {
    const criteria = describeSpec(spec);
    let raw: unknown;
    try {
      raw = await this.aws.json([
        'ec2',
        'describe-instances',
        '--filters',
        ...buildEc2Filters(spec),
        '--query',
        "Reservations[].Instances[].{id:InstanceId,launch:LaunchTime,name:Tags[?Key=='Name']|[0].Value}",
        ...contextArgs(ctx),
      ]);
    } catch (err) {
      this.fail(
        tunnelName,
        `bastion lookup failed (ec2 describe-instances): ${(err as Error).message}`,
        'The lookup needs ec2:DescribeInstances for the tunnel profile/region.',
        err,
      );
    }
    let candidates = parseInstances(raw);
    const matched = candidates.length;
    if (matched === 0) {
      this.fail(
        tunnelName,
        `no running instance matches ${criteria}`,
        `Check the filters with: aws ec2 describe-instances ${contextArgs(ctx).join(' ')} --filters ${buildEc2Filters(spec).join(' ')}`,
      );
    }

    if (spec.require_ssm_online) {
      const online = await this.ssmOnline(
        tunnelName,
        candidates.map((c) => c.instanceId),
        ctx,
      );
      const before = candidates;
      candidates = candidates.filter((c) => online.has(c.instanceId));
      if (candidates.length === 0) {
        this.fail(
          tunnelName,
          `instances match ${criteria} but none has an Online SSM agent: ${summary(before)}`,
          'The bastion may still be booting. Retry in a minute, or set discover.require_ssm_online=false.',
        );
      }
    }

    if (spec.pick === 'single' && candidates.length > 1) {
      this.fail(
        tunnelName,
        `${candidates.length} instances match ${criteria} and pick="single": ${summary(candidates)}`,
        'Narrow the filters (e.g. add vpc_id or a Name tag) or set discover.pick to "newest"/"oldest".',
      );
    }
    const sorted = [...candidates].sort((a, b) => launchMs(b) - launchMs(a));
    const chosen = (spec.pick === 'oldest' ? sorted[sorted.length - 1] : sorted[0])!;

    this.logger.info('ssm bastion discovered', {
      tunnel: tunnelName,
      instanceId: chosen.instanceId,
      name: chosen.name,
      launchTime: chosen.launchTime,
      matched,
      eligible: candidates.length,
      criteria,
    });
    return { ...chosen, matched };
  }

  private async ssmOnline(tunnelName: string, ids: string[], ctx: AwsContext): Promise<Set<string>> {
    const online = new Set<string>();
    // The InstanceIds filter accepts at most 50 values per call.
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      let raw: unknown;
      try {
        raw = await this.aws.json([
          'ssm',
          'describe-instance-information',
          '--filters',
          `Key=InstanceIds,Values=${chunk.join(',')}`,
          '--query',
          'InstanceInformationList[].{id:InstanceId,ping:PingStatus}',
          ...contextArgs(ctx),
        ]);
      } catch (err) {
        this.fail(
          tunnelName,
          `SSM agent status check failed (ssm describe-instance-information): ${(err as Error).message}`,
          'Grant ssm:DescribeInstanceInformation, or set discover.require_ssm_online=false.',
          err,
        );
      }
      if (!Array.isArray(raw)) continue;
      for (const item of raw as unknown[]) {
        const r = item as { id?: unknown; ping?: unknown } | null;
        if (r && typeof r.id === 'string' && r.ping === 'Online') online.add(r.id);
      }
    }
    return online;
  }
}
