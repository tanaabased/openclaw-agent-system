import GitHubRequestCooldown from '../core/github-request-cooldown.ts';
import {
  GitHubAccountClientError,
  type ConnectedGitHubAccountClient,
} from '../core/github-account-client.ts';
import { githubCliDiagnostic } from '../credentials/github-diagnostic.ts';
import { parseGitHubApiResponse } from '../channels/github/provider/api-response.ts';

import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';
import { resolveToolExecutable } from '../api/cli-runner.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import GitHubWorkItemClient from '../channels/github/provider/work-item-client.ts';
import readItemContext from '../channels/github/provider/read-item-context.ts';
import { githubResponseIdentity } from '../channels/github/provider/work-event-normalization.ts';
import runCodexSetupProcess from './codex-process-runner.ts';
import type { SetupProcessRunner } from './setup-runner.ts';

const cooldown = new GitHubRequestCooldown();

export interface CodexGitHubConnection {
  client: GitHubNotificationIntakeClient & GitHubNotificationItemContextClient;
  account: Pick<ConnectedGitHubAccountClient, 'identity' | 'execute'>;
}

/** ambient host authorization only; no manifest environment, tokens, or managed gh configuration. */
export default async function connectCodexGitHubAccount(
  workspace: string,
  signal: AbortSignal,
  run: SetupProcessRunner = runCodexSetupProcess,
): Promise<CodexGitHubConnection> {
  const executable = await resolveToolExecutable('gh', process.env.PATH ?? '');
  const execute: ConnectedGitHubAccountClient['execute'] = async (argv, stdin, options) => {
    const blocked = cooldown.inspect('github.com:codex-host', argv);
    if (blocked)
      throw new GitHubAccountClientError(
        'github-account-rate-limited',
        'GitHub requests are paused until the provider cooldown expires.',
        undefined,
        blocked,
      );
    const result = await run([executable, ...argv, '--hostname', 'github.com'], {
      cwd: workspace,
      baseEnv: process.env,
      env: { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
      input: stdin ?? '',
      timeoutMs: options?.timeoutMs ?? 30_000,
      maxOutputBytes: options?.maxOutputBytes ?? 512 * 1024,
      maxCombinedOutputBytes: options?.maxOutputBytes ?? 512 * 1024,
      killGraceMs: 1000,
      killProcessTree: true,
      outputCapture: 'head',
      signal,
    });
    const captured = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
      timedOut: result.termination !== 'exit',
      truncated: Boolean(result.stdoutTruncatedBytes || result.stderrTruncatedBytes),
    };
    cooldown.observe('github.com:codex-host', captured);
    return captured;
  };
  const result = await execute([
    'api',
    '/user',
    '--include',
    '--jq',
    '{login,nodeId:.node_id,type}',
  ]);
  if (result.exitCode !== 0 || result.timedOut || result.truncated)
    throw new GitHubAccountClientError(
      'intake-github-auth-unavailable',
      'The native GitHub identity check failed.',
      undefined,
      githubCliDiagnostic(result, 'identity-check'),
    );
  let identity;
  try {
    identity = githubResponseIdentity(
      JSON.parse(
        result.stdout.startsWith('HTTP/')
          ? parseGitHubApiResponse(result.stdout).body
          : result.stdout,
      ),
      'native account',
    );
    if (identity.type !== 'User') throw new Error('unsupported account');
  } catch {
    throw new IntakeError('intake-github-identity-invalid');
  }
  const api = new GitHubWorkEventApiClient({ identity, execute });
  const client = Object.assign(new GitHubWorkItemClient(api), {
    getItemContext: (owner: string, name: string, number: number) =>
      readItemContext(api, owner, name, number, 'issue', true),
  });
  return { client, account: { identity, execute } };
}
