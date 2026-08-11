import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import planAgentToolAccess, {
  type AgentToolAccessPlan,
  type CurrentAgentToolAccessState,
} from '../utils/plan-agent-tool-access.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
} from './lifecycle-registry.ts';

export interface ToolAccessLifecycleDependencies {
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

function findAgent(config: OpenClawConfig, agentId: string) {
  const normalizedAgentId = agentId.trim().toLowerCase();
  return config.agents?.list?.find(({ id }) => id.trim().toLowerCase() === normalizedAgentId);
}

function currentAgentToolAccess(
  config: OpenClawConfig,
  agentId: string,
): CurrentAgentToolAccessState {
  const agent = findAgent(config, agentId);
  if (!agent) return { exists: false };
  return {
    exists: true,
    ...(agent.tools?.allow === undefined ? {} : { allow: [...agent.tools.allow] }),
    ...(agent.tools?.alsoAllow === undefined ? {} : { alsoAllow: [...agent.tools.alsoAllow] }),
  };
}

function describeDrift(
  agentId: string,
  plan: Extract<AgentToolAccessPlan, { status: 'ready' }>,
): string {
  const details: string[] = [];
  if (plan.missing.length > 0) details.push(`is missing ${plan.missing.join(', ')}`);
  if (plan.stale.length > 0) details.push(`contains stale ${plan.stale.join(', ')}`);
  if (details.length === 0) details.push('does not contain each required grant exactly once');
  return `OpenClaw agents.list[].tools.${plan.target} for ${agentId} ${details.join(' and ')}.`;
}

/** Own manifest-derived access to Agent System's native model-facing tools. */
export default function createToolAccessLifecycleContribution(
  dependencies: ToolAccessLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'tool-access',
    isConfigured: () => true,
    async inspect(context) {
      const plan = planAgentToolAccess(
        context.manifest,
        currentAgentToolAccess(await dependencies.readConfig(), context.manifest.agent.id),
      );
      if (plan.status === 'missing-agent') {
        return [
          {
            code: 'agent-tool-access-agent-missing',
            message: `OpenClaw tool access for ${context.manifest.agent.id} cannot be inspected until the agent is registered.`,
            remediation: 'Run openclaw agent-system install from this workspace.',
            status: 'drift',
          },
        ];
      }
      return [
        plan.changed
          ? {
              code: 'agent-tool-access-drift',
              message: describeDrift(context.manifest.agent.id, plan),
              remediation: 'Run openclaw agent-system install from this workspace.',
              status: 'drift' as const,
            }
          : {
              code: 'agent-tool-access-ready',
              message: `OpenClaw tool access for ${context.manifest.agent.id} matches the manifest.`,
              status: 'healthy' as const,
            },
      ];
    },
    async reconcile(context) {
      const agentId = context.manifest.agent.id;
      const before = planAgentToolAccess(
        context.manifest,
        currentAgentToolAccess(await dependencies.readConfig(), agentId),
      );
      if (before.status === 'missing-agent') {
        throw new AgentSystemLifecycleError(
          'tool-access',
          'agent-tool-access-agent-missing',
          `OpenClaw agent ${agentId} is unavailable for tool access setup.`,
        );
      }
      if (!before.changed) {
        return {
          outcomes: [
            {
              code: 'agent-tool-access-unchanged',
              message: `OpenClaw tool access for ${agentId}`,
              status: 'unchanged',
            },
          ],
        };
      }

      const mutation = await dependencies.mutateConfigFile({
        base: 'source',
        afterWrite: { mode: 'auto' },
        mutate(config) {
          const agent = findAgent(config, agentId);
          if (!agent) {
            throw new AgentSystemLifecycleError(
              'tool-access',
              'agent-tool-access-agent-missing',
              `OpenClaw agent ${agentId} is unavailable for tool access setup.`,
            );
          }
          const plan = planAgentToolAccess(
            context.manifest,
            currentAgentToolAccess(config, agentId),
          );
          if (plan.status === 'missing-agent') return false;
          if (!plan.changed) return false;
          agent.tools ??= {};
          agent.tools[plan.target] = [...plan.next];
          return true;
        },
      });

      const verification = planAgentToolAccess(
        context.manifest,
        currentAgentToolAccess(await dependencies.readConfig(), agentId),
      );
      if (verification.status === 'missing-agent' || verification.changed) {
        throw new AgentSystemLifecycleError(
          'tool-access',
          'agent-tool-access-verification-failed',
          `OpenClaw tool access for ${agentId} did not match its manifest after installation.`,
        );
      }

      return {
        outcomes: [
          mutation.result === true
            ? {
                code: 'set-agent-tool-access',
                message: `OpenClaw tool access for ${agentId}`,
                status: 'updated' as const,
              }
            : {
                code: 'agent-tool-access-unchanged',
                message: `OpenClaw tool access for ${agentId}`,
                status: 'unchanged' as const,
              },
        ],
      };
    },
  };
}
