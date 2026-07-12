import type { ConfigService } from '../config/config.service';
import { resolveEnvRef } from '../config/env-ref';
import type { SsoSessionManager } from '../tunnels/sso-session';

export interface ResolvedAwsProfile {
  profile?: string;
  region?: string;
  reloadIntervalMs?: number;
}

/**
 * Shared entry point for every secret provider referencing an
 * aws_secret_profiles entry (aws, aws_iam, aws_redshift_creds): resolves
 * env-refs and — when the profile declares an `sso` block — runs the same SSO
 * bootstrap as ssm tunnels BEFORE the credentials are used. Called on every
 * secret resolution (clients are cached by the providers, sessions are not).
 */
export class AwsProfileResolver {
  constructor(
    private readonly configService: ConfigService,
    private readonly ssoSessions: SsoSessionManager,
  ) {}

  async resolve(target: string | undefined): Promise<ResolvedAwsProfile> {
    if (target === undefined) return {}; // default AWS SDK credential chain, no bootstrap

    const entry = this.configService.getAwsSecretProfile(target);
    const profile = resolveEnvRef(entry.aws_profile, `aws_secret_profiles "${target}" aws_profile`);
    const region = resolveEnvRef(entry.aws_region, `aws_secret_profiles "${target}" aws_region`);

    if (entry.sso) {
      await this.ssoSessions.ensureSession({
        session: entry.sso.session,
        profile: entry.sso.profile ?? profile,
        timeoutMs: entry.sso.timeout_ms,
      });
    }

    return { profile, region, reloadIntervalMs: entry.reload_interval_ms };
  }
}
