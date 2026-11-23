import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPlatform } from '../platform/platform';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** Runs a read-only aws CLI command and returns its parsed JSON output. */
export interface AwsCliRunner {
  json(args: string[], opts?: { timeoutMs?: number }): Promise<unknown>;
}

function isSpawnFailure(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Default runner: fixed-argument execFile (no shell), `--output json` appended.
 * The platform's aws command candidates are probed once (aws vs aws.cmd on
 * Windows); the first one that spawns is reused for every later call.
 */
export function defaultAwsCliRunner(): AwsCliRunner {
  let resolved: string | undefined;
  return {
    async json(args, opts = {}) {
      const fullArgs = [...args, '--output', 'json'];
      const candidates = resolved ? [resolved] : getPlatform().awsCommandCandidates();
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          const { stdout } = await execFileAsync(candidate, fullArgs, {
            timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: MAX_BUFFER,
            windowsHide: true,
          });
          resolved = candidate;
          const text = stdout.toString().trim();
          return text === '' ? null : (JSON.parse(text) as unknown);
        } catch (err) {
          lastError = err;
          if (!isSpawnFailure(err)) break;
        }
      }
      const e = lastError as (Error & { stderr?: string | Buffer }) | undefined;
      const stderr = e?.stderr?.toString().trim();
      throw new Error(stderr && stderr !== '' ? stderr.slice(-1_000) : (e?.message ?? 'aws CLI call failed'));
    },
  };
}
