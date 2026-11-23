import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../../src/config/config.service';
import { ssmDiscoverSchema, type SsmDiscoverSettings } from '../../src/config/schema';
import { DbAccessError } from '../../src/errors';
import type { TunnelHandle, TunnelOpenRequest } from '../../src/interfaces/tunnel-provider';
import { StderrLogger } from '../../src/logging/logger';
import type { AwsCliRunner } from '../../src/tunnels/aws-cli';
import { SsmTunnelProvider } from '../../src/tunnels/ssm.provider';
import { buildEc2Filters, SsmTargetResolver } from '../../src/tunnels/ssm-target-resolver';

const logger = new StderrLogger('silent');

interface FakeInstance {
  id: string;
  launch?: string;
  name?: string;
  ping?: string;
}

/** Fake aws CLI: answers ec2 describe-instances / ssm describe-instance-information from a mutable list. */
function fakeAws(state: { instances: FakeInstance[] }) {
  const calls: string[][] = [];
  const runner: AwsCliRunner = {
    async json(args) {
      calls.push(args);
      if (args[0] === 'ec2') return state.instances.map(({ id, launch, name }) => ({ id, launch, name }));
      if (args[0] === 'ssm') {
        const ids = (args[3] ?? '').replace('Key=InstanceIds,Values=', '').split(',');
        return state.instances
          .filter((i) => ids.includes(i.id))
          .map((i) => ({ id: i.id, ping: i.ping ?? 'Online' }));
      }
      throw new Error(`unexpected aws call: ${args.join(' ')}`);
    },
  };
  return { runner, calls };
}

function spec(input: Record<string, unknown>): SsmDiscoverSettings {
  return ssmDiscoverSchema.parse(input);
}

describe('ssm discover config', () => {
  const base = { region: 'us-east-1', profile: 'p' };
  const parse = (options: Record<string, unknown>) =>
    parseConfig({ tunnels: { t: { type: 'ssm', options: { ...base, ...options } } } });

  it('accepts target only, discover only, and both', () => {
    expect(() => parse({ target: 'i-1' })).not.toThrow();
    expect(() => parse({ discover: { tags: { Name: 'bastion' } } })).not.toThrow();
    expect(() => parse({ target: 'i-1', discover: { vpc_id: 'vpc-1' } })).not.toThrow();
  });

  it('rejects a tunnel with neither target nor discover', () => {
    expect(() => parse({})).toThrow(/target.*discover/);
  });

  it('rejects an empty discover block and unknown keys', () => {
    expect(() => parse({ discover: {} })).toThrow(/at least one criterion/);
    expect(() => parse({ discover: { tags: { Name: 'x' }, vpc: 'vpc-1' } })).toThrow();
  });

  it('applies defaults', () => {
    const s = spec({ tags: { Name: 'b' } });
    expect(s).toMatchObject({ require_ssm_online: true, pick: 'newest', cache_ttl_ms: 300_000, filters: {} });
  });
});

describe('buildEc2Filters', () => {
  it('maps every criterion to an EC2 filter and always requires running', () => {
    const filters = buildEc2Filters(
      spec({
        tags: { Name: 'devops-brothers-rtb', team: ['brothers', 'hounds'] },
        vpc_id: 'vpc-21784959',
        subnet_id: ['subnet-a', 'subnet-b'],
        security_group_id: 'sg-1',
        filters: { 'instance-type': 't3a.micro' },
      }),
    );
    expect(filters).toEqual([
      'Name=instance-state-name,Values=running',
      'Name=tag:Name,Values=devops-brothers-rtb',
      'Name=tag:team,Values=brothers,hounds',
      'Name=vpc-id,Values=vpc-21784959',
      'Name=subnet-id,Values=subnet-a,subnet-b',
      'Name=instance.group-id,Values=sg-1',
      'Name=instance-type,Values=t3a.micro',
    ]);
  });

  it('uses the JSON form when a value contains a comma', () => {
    const filters = buildEc2Filters(spec({ tags: { Note: 'a,b' } }));
    expect(filters[1]).toBe(JSON.stringify({ Name: 'tag:Note', Values: ['a,b'] }));
  });
});

describe('SsmTargetResolver', () => {
  const ctx = { region: 'us-east-1', profile: 'p' };

  it('picks the newest instance with an Online SSM agent and passes region/profile', async () => {
    const { runner, calls } = fakeAws({
      instances: [
        { id: 'i-old', launch: '2026-11-01T00:00:00Z' },
        { id: 'i-new', launch: '2026-11-20T00:00:00Z' },
        { id: 'i-newest-offline', launch: '2026-11-21T00:00:00Z', ping: 'ConnectionLost' },
      ],
    });
    const resolver = new SsmTargetResolver(logger, runner);
    const got = await resolver.resolve('t', spec({ tags: { Name: 'b' } }), ctx);
    expect(got).toMatchObject({ instanceId: 'i-new', matched: 3, fromCache: false });
    expect(calls[0]).toEqual(expect.arrayContaining(['--region', 'us-east-1', '--profile', 'p']));
  });

  it('honours pick=oldest and skips the SSM check when require_ssm_online=false', async () => {
    const { runner, calls } = fakeAws({
      instances: [
        { id: 'i-a', launch: '2026-11-20T00:00:00Z', ping: 'ConnectionLost' },
        { id: 'i-b', launch: '2026-11-01T00:00:00Z', ping: 'ConnectionLost' },
      ],
    });
    const resolver = new SsmTargetResolver(logger, runner);
    const got = await resolver.resolve('t', spec({ vpc_id: 'v', pick: 'oldest', require_ssm_online: false }), ctx);
    expect(got.instanceId).toBe('i-b');
    expect(calls.every((c) => c[0] === 'ec2')).toBe(true);
  });

  it('fails with TUNNEL_FAILED when nothing matches, none is online, or pick=single is ambiguous', async () => {
    const empty = new SsmTargetResolver(logger, fakeAws({ instances: [] }).runner);
    await expect(empty.resolve('t', spec({ tags: { Name: 'b' } }), ctx)).rejects.toMatchObject({
      code: 'TUNNEL_FAILED',
      message: expect.stringContaining('no running instance matches tag:Name=b'),
    });

    const offline = new SsmTargetResolver(logger, fakeAws({ instances: [{ id: 'i-1', ping: 'Inactive' }] }).runner);
    await expect(offline.resolve('t', spec({ tags: { Name: 'b' } }), ctx)).rejects.toThrow(/none has an Online SSM agent/);

    const two = new SsmTargetResolver(logger, fakeAws({ instances: [{ id: 'i-1' }, { id: 'i-2' }] }).runner);
    await expect(two.resolve('t', spec({ tags: { Name: 'b' }, pick: 'single' }), ctx)).rejects.toThrow(
      /2 instances match/,
    );
  });

  it('caches for cache_ttl_ms, bypasses the cache on fresh, and expires', async () => {
    let now = 1_000;
    const state = { instances: [{ id: 'i-1' }] as FakeInstance[] };
    const { runner, calls } = fakeAws(state);
    const resolver = new SsmTargetResolver(logger, runner, () => now);
    const s = spec({ tags: { Name: 'b' }, cache_ttl_ms: 10_000, require_ssm_online: false });

    expect((await resolver.resolve('t', s, ctx)).fromCache).toBe(false);
    state.instances = [{ id: 'i-2' }];
    expect(await resolver.resolve('t', s, ctx)).toMatchObject({ instanceId: 'i-1', fromCache: true });
    expect(resolver.peek('t', s, ctx)?.instanceId).toBe('i-1');
    expect(calls).toHaveLength(1);

    expect((await resolver.resolve('t', s, ctx, { fresh: true })).instanceId).toBe('i-2');
    now += 10_001;
    expect(resolver.peek('t', s, ctx)).toBeUndefined();
    resolver.invalidate('t');
    expect(resolver.peek('t', s, ctx)).toBeUndefined();
  });

  it('shares one lookup between concurrent callers', async () => {
    const { runner, calls } = fakeAws({ instances: [{ id: 'i-1' }] });
    const resolver = new SsmTargetResolver(logger, runner);
    const s = spec({ tags: { Name: 'b' }, require_ssm_online: false });
    const [a, b] = await Promise.all([resolver.resolve('t', s, ctx), resolver.resolve('t', s, ctx)]);
    expect(a.instanceId).toBe('i-1');
    expect(b.instanceId).toBe('i-1');
    expect(calls).toHaveLength(1);
  });

  it('wraps aws CLI failures with a permissions hint', async () => {
    const resolver = new SsmTargetResolver(logger, {
      json: async () => {
        throw new Error('AccessDenied');
      },
    });
    const err = await resolver.resolve('t', spec({ tags: { Name: 'b' } }), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbAccessError);
    expect((err as DbAccessError).message).toMatch(/AccessDenied/);
  });
});

describe('SsmTunnelProvider target/discover fallback', () => {
  function setup(instances: FakeInstance[], deadTargets: string[]) {
    const state = { instances };
    const aws = fakeAws(state);
    const resolver = new SsmTargetResolver(logger, aws.runner);
    const provider = new SsmTunnelProvider(logger, undefined, resolver);
    const attempts: string[] = [];
    const dead = new Set(deadTargets);
    vi.spyOn(provider as unknown as { openTarget: () => unknown }, 'openTarget').mockImplementation(((
      _req: TunnelOpenRequest,
      _opts: unknown,
      target: string,
    ) => {
      attempts.push(target);
      if (dead.has(target)) {
        return Promise.reject(new DbAccessError('TUNNEL_FAILED', `TargetNotConnected: ${target}`));
      }
      return Promise.resolve({ target } as unknown as TunnelHandle);
    }) as never);
    return { provider, attempts, aws, state };
  }

  function request(options: Record<string, unknown>): TunnelOpenRequest {
    const config = parseConfig({
      tunnels: { t: { type: 'ssm', options: { region: 'us-east-1', profile: 'p', ...options } } },
    }).tunnels['t']!;
    return { name: 't', config, remote: { host: 'db', port: 5432 }, localPort: 20_100 };
  }

  const discover = { tags: { Name: 'devops-brothers-rtb' }, vpc_id: 'vpc-21784959' };

  it('target only: opens the pinned id without any lookup', async () => {
    const { provider, attempts, aws } = setup([], []);
    await provider.open(request({ target: 'i-pinned' }));
    expect(attempts).toEqual(['i-pinned']);
    expect(aws.calls).toHaveLength(0);
  });

  it('target + discover: a working target needs no lookup', async () => {
    const { provider, attempts, aws } = setup([{ id: 'i-new' }], []);
    await provider.open(request({ target: 'i-pinned', discover }));
    expect(attempts).toEqual(['i-pinned']);
    expect(aws.calls).toHaveLength(0);
  });

  it('target + discover: a dead target falls back to the discovered instance, which is then reused', async () => {
    const { provider, attempts } = setup([{ id: 'i-new' }], ['i-pinned']);
    const handle = await provider.open(request({ target: 'i-pinned', discover }));
    expect(handle.target).toBe('i-new');
    expect(attempts).toEqual(['i-pinned', 'i-new']);

    // While the lookup is cached the dead pinned id is not retried.
    await provider.open(request({ target: 'i-pinned', discover }));
    expect(attempts).toEqual(['i-pinned', 'i-new', 'i-new']);
  });

  it('discover only: opens the discovered instance and re-discovers after a recreate', async () => {
    const { provider, attempts, state } = setup([{ id: 'i-1' }], []);
    await provider.open(request({ discover }));
    expect(attempts).toEqual(['i-1']);

    // Bastion recreated: the cached i-1 fails, a fresh lookup finds i-2.
    state.instances = [{ id: 'i-2' }];
    vi.mocked((provider as unknown as { openTarget: () => unknown }).openTarget).mockImplementation(((
      _r: unknown,
      _o: unknown,
      target: string,
    ) => {
      attempts.push(target);
      return target === 'i-1'
        ? Promise.reject(new DbAccessError('TUNNEL_FAILED', 'TargetNotConnected'))
        : Promise.resolve({ target } as unknown as TunnelHandle);
    }) as never);
    const handle = await provider.open(request({ discover }));
    expect(handle.target).toBe('i-2');
    expect(attempts).toEqual(['i-1', 'i-1', 'i-2']);
  });

  it('rethrows the original error when the lookup finds the same instance or fails', async () => {
    const same = setup([{ id: 'i-pinned' }], ['i-pinned']);
    await expect(same.provider.open(request({ target: 'i-pinned', discover }))).rejects.toThrow(
      /TargetNotConnected: i-pinned/,
    );
    expect(same.attempts).toEqual(['i-pinned']);

    const none = setup([], ['i-pinned']);
    await expect(none.provider.open(request({ target: 'i-pinned', discover }))).rejects.toThrow(
      /TargetNotConnected: i-pinned/,
    );
  });
});
