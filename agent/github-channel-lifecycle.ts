import { realpath } from 'node:fs/promises';

import type { ToolAccessLifecycleDependencies } from '../api/access-lifecycle.ts';
import {
  githubChannelAccounts,
  githubChannelId,
  ownsGitHubChannelAccount,
  wantsGitHubChannel,
} from '../channels/github/channel-config.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleExecutionContext,
} from '../core/lifecycle-registry.ts';

export default function createGitHubChannelLifecycle(
  dependencies: Pick<ToolAccessLifecycleDependencies, 'readConfig' | 'mutateConfigFile'>,
): AgentSystemLifecycleContribution {
  const component = 'github-channel';
  const plan = (
    config: Awaited<ReturnType<typeof dependencies.readConfig>>,
    agentId: string,
    workspace: string,
    enabled: boolean,
  ) => {
    const current = githubChannelAccounts(config)[agentId];
    if (current && !ownsGitHubChannelAccount(config, agentId, workspace)) return 'conflict';
    if (!current && !enabled) return 'absent';
    return current?.enabled === enabled && current.managedWorkspace === workspace
      ? 'aligned'
      : 'drift';
  };
  return {
    id: component,
    isConfigured: () => true,
    async inspect({ manifest, workspaceDir }) {
      const state = plan(
        await dependencies.readConfig(),
        manifest.agent.id,
        await realpath(workspaceDir),
        wantsGitHubChannel(manifest),
      );
      if (state === 'absent') return [];
      return [
        {
          component,
          code: `github-channel-${state}`,
          status: state === 'conflict' ? 'blocked' : state === 'aligned' ? 'healthy' : 'drift',
          message: `GitHub readiness account: ${state}.`,
          ...(state === 'aligned'
            ? {}
            : {
                remediation:
                  state === 'conflict'
                    ? 'Resolve the existing channel account ownership before installing.'
                    : 'Run Agent System Install to reconcile this agent’s readiness account.',
              }),
        },
      ];
    },
    async reconcile(context) {
      const { manifest, workspaceDir } = context;
      const workspace = await realpath(workspaceDir);
      const agentId = manifest.agent.id;
      const enabled = wantsGitHubChannel(manifest);
      const execution = context as AgentSystemLifecycleExecutionContext;
      const state = plan(await dependencies.readConfig(), agentId, workspace, enabled);
      const assertOwned = (value: string) => {
        if (value === 'conflict')
          throw new AgentSystemLifecycleError(
            component,
            'github-channel-conflict',
            'The GitHub channel account belongs to another workspace or is not managed by Agent System.',
          );
      };
      assertOwned(state);
      let changed = false;
      if (state === 'drift') {
        await execution.assertCurrent?.();
        execution.signal?.throwIfAborted();
        await dependencies.mutateConfigFile({
          base: 'source',
          afterWrite: { mode: 'auto' },
          mutate(config) {
            execution.signal?.throwIfAborted();
            const latest = plan(config, agentId, workspace, enabled);
            assertOwned(latest);
            if (latest !== 'drift') return false;
            config.channels ??= {};
            const channel = (config.channels[githubChannelId] ??= { accounts: {} }) as {
              accounts: Record<string, unknown>;
            };
            channel.accounts[agentId] = {
              ...githubChannelAccounts(config)[agentId],
              enabled,
              managedWorkspace: workspace,
            };
            changed = true;
            return true;
          },
        });
        const verified = plan(await dependencies.readConfig(), agentId, workspace, enabled);
        if (verified !== 'aligned')
          throw new AgentSystemLifecycleError(
            component,
            'github-channel-verification-failed',
            'The GitHub readiness account did not retain the installed configuration.',
          );
      }
      return {
        outcomes:
          state === 'absent'
            ? []
            : [
                {
                  component,
                  code: enabled ? 'github-channel-enabled' : 'github-channel-disabled',
                  status: changed ? 'updated' : 'unchanged',
                  message: `GitHub readiness account ${enabled ? 'enabled' : 'disabled'}.`,
                },
              ],
        warnings: [],
      };
    },
  };
}
