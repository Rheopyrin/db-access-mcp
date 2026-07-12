import { z } from 'zod';
import { DbAccessError } from '../errors';
import type { ResolvedSecret, SecretProvider } from '../interfaces/secret-provider';

/** Spec: map of placeholder key -> environment variable name. */
const envSpecSchema = z.record(z.string().min(1));

export class EnvSecretProvider implements SecretProvider {
  readonly name = 'env';

  async resolve(spec: unknown, connectionKey: string): Promise<ResolvedSecret> {
    const parsed = envSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new DbAccessError(
        'CONFIG_INVALID',
        `connection "${connectionKey}": "secrets.env" must map placeholder names to environment variable names`,
      );
    }
    const data: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const [key, envVar] of Object.entries(parsed.data)) {
      const value = process.env[envVar];
      if (value === undefined) {
        missing.push(envVar);
      } else {
        data[key] = value;
      }
    }
    if (missing.length > 0) {
      throw new DbAccessError(
        'SECRET_RESOLUTION_FAILED',
        `connection "${connectionKey}": missing environment variable(s): ${missing.join(', ')}`,
        { hint: 'Export the variables in the environment that launches the MCP server.' },
      );
    }
    return { data };
  }
}
