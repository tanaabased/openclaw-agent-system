import { isDeepStrictEqual } from 'node:util';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';

import type { AgentManifest } from '../../manifest/types.ts';

export const githubChannelId = 'agent-system-github';

export interface GitHubChannelAccount {
  enabled: boolean;
  managedWorkspace?: string;
}

export function githubChannelAccounts(
  config: OpenClawConfig,
): Record<string, GitHubChannelAccount> {
  return (
    (
      config.channels?.[githubChannelId] as
        { accounts?: Record<string, GitHubChannelAccount> } | undefined
    )?.accounts ?? {}
  );
}

export function wantsGitHubChannel(manifest: AgentManifest): boolean {
  const policy = manifest.github?.notifications;
  return Boolean(
    policy?.schemaVersion === 2 &&
    policy.runtimes.includes('openclaw') &&
    [policy.issueAssignment, policy.reviewRequest].some(
      (workflow) => workflow && (workflow.enabled ?? Boolean(workflow.allowed.length)),
    ),
  );
}

export function ownsGitHubChannelAccount(
  config: OpenClawConfig,
  agentId: string,
  workspace: string,
): boolean {
  const account = githubChannelAccounts(config)[agentId];
  if (!account) return false;
  if (account.managedWorkspace) return account.managedWorkspace === workspace;
  // only adopt an unmarked v1 account with its exact install-owned binding.
  return (
    config.bindings?.some((binding) =>
      isDeepStrictEqual(binding, {
        type: 'route',
        agentId,
        comment: 'managed by agent system github notifications',
        match: { channel: githubChannelId, accountId: agentId },
        session: { dmScope: 'per-account-channel-peer' },
      }),
    ) ?? false
  );
}
