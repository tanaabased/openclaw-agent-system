import AgentSystemToolError from '../../api/error.ts';
import type { AgentSystemCliResult, AgentSystemCliRunner } from '../../api/types.ts';

export const googleIdentityArgv = [
  'api',
  'call',
  'oauth2',
  'v2',
  'oauth2.userinfo.get',
  '--scope=https://www.googleapis.com/auth/userinfo.email',
  '--no-cache',
];

export function googleFailureStatus(result: AgentSystemCliResult) {
  if (result.exitCode !== 0 && /API is not enabled/u.test(result.stderr)) return 'api-disabled';
  if (
    result.exitCode !== 0 &&
    /aes\.keyunwrap|integrity check failed|file keyring password mismatch/u.test(result.stderr)
  )
    return 'keyring-unavailable';
  if (result.exitCode === 4 && /OAuth grant .* is missing required .* scope:/u.test(result.stderr))
    return 'insufficient-scope';
  if (result.exitCode === 4) return 'authentication-rejected';
  if (result.exitCode === 6) return 'permission-denied';
  if (result.exitCode === 10) return 'setup-required';
  return result.exitCode === 0 ? 'ok' : 'failed';
}

export function assertGoogleResult(result: AgentSystemCliResult): void {
  if (result.timedOut)
    throw new AgentSystemToolError('execution_timed_out', 'Google request timed out.');
  if (result.exitCode === 0 && !result.truncated) return;
  if (googleFailureStatus(result) === 'api-disabled')
    throw new AgentSystemToolError(
      'configuration_unavailable',
      'The Google service API is not enabled. Enable it in the OAuth client project, then retry.',
    );
  if (googleFailureStatus(result) === 'keyring-unavailable')
    throw new AgentSystemToolError(
      'credential_unavailable',
      'Google file keyring could not be unlocked. Check the declared keyring password and run install.',
    );
  if (googleFailureStatus(result) === 'insufficient-scope')
    throw new AgentSystemToolError(
      'execution_failed',
      'Google OAuth grant lacks a required scope. Reauthorize with the needed service scopes and run install.',
    );
  if (result.exitCode === 4)
    throw new AgentSystemToolError(
      'execution_failed',
      'Google rejected authentication. Reauthorize the declared account and run install.',
      true,
    );
  if (result.exitCode === 6)
    throw new AgentSystemToolError(
      'execution_failed',
      'Google denied the operation. Check OAuth scopes and resource permissions.',
    );
  if (result.exitCode === 10)
    throw new AgentSystemToolError(
      'configuration_unavailable',
      'Google credential configuration requires install.',
    );
  throw new AgentSystemToolError(
    'execution_failed',
    'Google request failed; upstream details were withheld.',
  );
}

export function assertGoogleIdentity(result: AgentSystemCliResult, account: string): void {
  assertGoogleResult(result);
  let identity;
  try {
    identity = JSON.parse(result.stdout);
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw new Error();
  } catch {
    throw new AgentSystemToolError(
      'execution_failed',
      'Google returned an invalid authenticated identity response.',
    );
  }
  if (
    typeof identity.email !== 'string' ||
    identity.email.trim().toLowerCase() !== account ||
    identity.verified_email !== true
  )
    throw new AgentSystemToolError(
      'tool_identity_mismatch',
      'Google authenticated an account that does not match the declared Google account.',
    );
}

/** Use fixed GoG routes, bounded IO, and an explicitly selected isolated OAuth client. */
export default class GoogleClient {
  constructor(
    private readonly runCli: AgentSystemCliRunner,
    private readonly baseEnvironment: Readonly<NodeJS.ProcessEnv>,
    private readonly excludedDirectories: readonly string[] = [],
    private readonly signal?: AbortSignal,
  ) {}

  withScope(excludedDirectories: readonly string[], signal?: AbortSignal) {
    return new GoogleClient(
      this.runCli,
      this.baseEnvironment,
      [...this.excludedDirectories, ...excludedDirectories],
      signal,
    );
  }

  async run(
    environment: Record<string, string>,
    cwd: string,
    account: string,
    argv: string[],
    stdin?: string,
  ) {
    try {
      return await this.runCli({
        executable: 'gog',
        argv: ['--account=' + account, '--client=agent-system', '--no-input', '--json', ...argv],
        cwd,
        environment: {
          PATH: this.baseEnvironment.PATH,
          LANG: this.baseEnvironment.LANG,
          ...environment,
        },
        excludedExecutableDirectories: [...this.excludedDirectories, cwd + '/bin'],
        ...(this.signal ? { signal: this.signal } : {}),
        maxOutputBytes: 65536,
        timeoutMs: 30000,
        ...(stdin === undefined ? {} : { stdin }),
      });
    } catch {
      throw new AgentSystemToolError(
        'tool_unavailable',
        'The google tool requires gog on the host runtime PATH. Install GoG v0.42.0.',
      );
    }
  }

  async checkVersion(environment: Record<string, string>, cwd: string, account: string) {
    const version = await this.run(environment, cwd, account, ['--version']);
    assertGoogleResult(version);
    if (!/^(?:gog(?:cli)?\s+)?v?0\.42\.0(?:\s|$)/u.test(version.stdout.trim()))
      throw new AgentSystemToolError(
        'tool_unavailable',
        'Managed Google commands require the reviewed GoG v0.42.0 command contract.',
      );
  }

  async verify(environment: Record<string, string>, cwd: string, account: string) {
    await this.checkVersion(environment, cwd, account);
    assertGoogleIdentity(await this.run(environment, cwd, account, googleIdentityArgv), account);
  }
}
