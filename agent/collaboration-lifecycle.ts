import { stat } from 'node:fs/promises';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import configuredAgentEntries from '../core/configured-agents.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
} from '../core/lifecycle-registry.ts';
import discoverManifest from '../manifest/discover.ts';
import { loadDiscoveredManifest } from '../manifest/load.ts';
import planCollaboration, {
  collaborationConfiguration,
  collaborationError,
} from './collaboration-plan.ts';

export interface CollaborationDependencies {
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  resolveAgentWorkspaceDir(config: OpenClawConfig, agentId: string): string;
  mutateConfigFile(params: {
    base: 'source';
    afterWrite: { mode: 'auto' };
    mutate(config: OpenClawConfig): Promise<boolean>;
  }): Promise<unknown>;
}

/** discover registered managed agents without environment resolution or lifecycle effects. */
export async function discoverCollaborationMembers(
  config: OpenClawConfig,
  dependencies: Pick<CollaborationDependencies, 'resolveAgentWorkspaceDir'>,
): Promise<string[]> {
  const { selection, state } = collaborationConfiguration(config);
  if (selection === false || (Array.isArray(selection) && selection.length === 0)) return [];
  const members: string[] = [];
  for (const { id } of configuredAgentEntries(config)) {
    const workspace = dependencies.resolveAgentWorkspaceDir(config, id);
    try {
      if (!(await stat(workspace)).isDirectory()) throw new Error('not a directory');
      const loaded = await loadDiscoveredManifest(await discoverManifest(workspace), {
        expectedAgentId: id,
      });
      if (loaded.status === 'loaded') members.push(loaded.manifest.agent.id);
      else if (loaded.status !== 'unmanaged' || state?.ownedAgentIds.includes(id))
        throw new Error('unresolved manifest');
    } catch {
      throw collaborationError(
        'discovery-blocked',
        `Cannot establish managed membership for registered agent ${id}; repair its workspace or explicitly remove its registration before cleanup.`,
      );
    }
  }
  return members;
}

/** share the same host-scoped operation between ordinary and workspace-free lifecycle calls. */
export default function createCollaborationLifecycleContribution(
  dependencies: CollaborationDependencies,
) {
  async function plan(config: OpenClawConfig) {
    return planCollaboration(config, await discoverCollaborationMembers(config, dependencies));
  }
  const contribution = {
    id: 'collaboration',
    isConfigured: () => true,
    async inspect() {
      try {
        const result = await plan(await dependencies.readConfig());
        return [
          ...(result.unavailableMembers.length
            ? [
                {
                  code: 'collaboration-unavailable-members',
                  status: 'warning' as const,
                  message: `Selected IDs are not registered managed agents: ${result.unavailableMembers.join(', ')}. Register their managed workspaces or revise the selection.`,
                },
              ]
            : []),
          {
            code: result.changed ? 'collaboration-drift' : 'collaboration-ready',
            status: result.changed ? 'drift' : 'healthy',
            message: `Managed collaboration members: ${result.members.join(', ') || 'none'}. Retained operator entries: ${result.operatorEntries.join(', ') || 'none'}. Session access includes reading and messaging.`,
            ...(result.changed
              ? { remediation: 'Run openclaw agent-system install --collaboration.' }
              : {}),
          },
        ];
      } catch (error) {
        if (!(error instanceof AgentSystemLifecycleError)) throw error;
        return [{ code: error.code, status: 'blocked', message: error.message }];
      }
    },
    async reconcile() {
      let changed = false;
      await dependencies.mutateConfigFile({
        base: 'source',
        afterWrite: { mode: 'auto' },
        async mutate(config) {
          const result = await plan(config);
          if (!result.changed) return false;
          config.tools = result.config.tools;
          config.plugins = result.config.plugins;
          changed = true;
          return true;
        },
      });
      const verified = await plan(await dependencies.readConfig());
      if (verified.changed)
        throw collaborationError(
          'verification-failed',
          'Collaboration configuration changed during reconciliation; inspect Doctor before retrying.',
        );
      return {
        outcomes: [
          {
            code: changed ? 'collaboration-updated' : 'collaboration-unchanged',
            status: changed ? 'updated' : 'unchanged',
            message: `Managed collaboration: ${verified.members.join(', ') || 'none'}`,
          },
        ],
        warnings: [
          ...(verified.unavailableMembers.length
            ? [
                {
                  code: 'collaboration-unavailable-members',
                  message: `Selected IDs are not registered managed agents: ${verified.unavailableMembers.join(', ')}.`,
                },
              ]
            : []),
          ...(verified.members.length
            ? [
                {
                  code: 'collaboration-session-access',
                  message: `Collaboration permits session reading and messaging. Retained operator entries also participate: ${verified.operatorEntries.join(', ') || 'none'}.`,
                },
              ]
            : []),
        ],
      };
    },
  } satisfies AgentSystemLifecycleContribution;
  return {
    ...contribution,
    inspectHost: contribution.inspect,
    reconcileHost: contribution.reconcile,
  };
}
