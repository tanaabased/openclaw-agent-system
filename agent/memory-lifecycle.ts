import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { configuredAgentValue } from '../core/configured-agents.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleFinding,
} from '../core/lifecycle-registry.ts';
import createMemoryConfigurationPlan, {
  memorySecretProviderAlias,
  type MemoryConfigurationPlan,
  type ReadyMemoryConfigurationPlan,
} from './memory-configuration-plan.ts';
import {
  classifyMemoryEmbeddingFailure,
  memoryIndexState,
  type MemoryStatus,
} from './memory-status.ts';

export interface MemoryLifecycleDependencies {
  inspectMemoryStatus(params: {
    agentId: string;
    deep: boolean;
    workspaceDir: string;
  }): Promise<MemoryStatus>;
  inspectBinding(params: {
    agentId: string;
    binding: string;
  }): Promise<'available' | 'missing' | 'unavailable'>;
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
}

type ContributionFinding = Omit<AgentSystemLifecycleFinding, 'component'>;

function planFinding(
  plan: Exclude<MemoryConfigurationPlan, ReadyMemoryConfigurationPlan>,
): ContributionFinding {
  return {
    code:
      plan.status === 'missing-agent'
        ? 'agent-memory-agent-missing'
        : 'agent-memory-secret-provider-conflict',
    message: plan.message,
    remediation:
      plan.status === 'missing-agent'
        ? 'Run openclaw agent-system install from this workspace.'
        : `Move or remove the conflicting ${memorySecretProviderAlias} secret provider, then run doctor again.`,
    status: plan.status === 'missing-agent' ? 'drift' : 'blocked',
  };
}

function lifecycleError(finding: ContributionFinding): AgentSystemLifecycleError {
  return new AgentSystemLifecycleError('memory', finding.code, finding.message);
}

function indexFinding(status: MemoryStatus['status'], agentId: string): ContributionFinding[] {
  const state = memoryIndexState(status);
  if (
    !status.lastSyncError &&
    !['incomplete', 'unverified', 'mismatched', 'missing'].includes(state ?? '')
  ) {
    return [];
  }
  return [
    {
      code: 'agent-memory-index-incomplete',
      message: `OpenClaw reports incomplete or incompatible memory index evidence for ${agentId}.`,
      remediation: `Review openclaw memory status --agent ${agentId} --deep, then run openclaw memory status --index --force --agent ${agentId} when a rebuild is appropriate.`,
      status: 'drift',
    },
  ];
}

function providerMismatchFinding(
  status: MemoryStatus['status'],
  agentId: string,
  provider: string,
): ContributionFinding[] {
  const requested = status.requestedProvider ?? status.provider;
  if (requested === provider && status.provider === provider && !status.fallback) return [];
  if (provider === 'local') return [localProviderSetupFinding(agentId)];
  return [
    {
      code: 'agent-memory-provider-unavailable',
      message: `OpenClaw did not activate the declared ${provider} memory provider for ${agentId}.`,
      remediation: `Review openclaw memory status --agent ${agentId} --deep and restore the declared provider.`,
      status: 'blocked',
    },
  ];
}

function localProviderSetupFinding(agentId: string): ContributionFinding {
  return {
    code: 'agent-memory-provider-unavailable',
    message: `OpenClaw local memory search is not ready for ${agentId}.`,
    remediation: `Configure the managed local provider with openclaw models --agent ${agentId} auth login --provider llama-cpp --method local, then run openclaw memory status --agent ${agentId} --deep.`,
    status: 'blocked',
  };
}

function ftsFinding(status: MemoryStatus['status'], agentId: string): ContributionFinding[] {
  if (status.fts?.enabled === true && status.fts.available === true) return [];
  return [
    {
      code: 'agent-memory-fts-unavailable',
      message: `OpenClaw does not report usable keyword memory search for ${agentId}.`,
      remediation: `Review openclaw memory status --agent ${agentId}.`,
      status: 'blocked',
    },
  ];
}

function embeddingFailureFinding(
  status: MemoryStatus,
  agentId: string,
): ContributionFinding | undefined {
  const probe = status.embeddingProbe;
  if (!probe || probe.checked === false) {
    return {
      code: 'agent-memory-provider-unprobed',
      message: `OpenClaw has not verified the embedding provider for ${agentId}.`,
      remediation: `Run openclaw memory status --agent ${agentId} --deep.`,
      status: 'manual',
    };
  }
  if (probe.ok) return;
  const classification = classifyMemoryEmbeddingFailure(probe.error);
  const explanation = {
    authentication: 'authentication failed',
    'billing-or-quota': 'billing or embedding quota is unavailable',
    permission: 'the credential lacks embedding permission',
    transport: 'the provider could not be reached',
    unknown: 'the provider returned an unclassified failure',
  }[classification];
  return {
    code: `agent-memory-openai-${classification}`,
    message: `OpenClaw reports that ${explanation} for ${agentId}.`,
    remediation: `Restore OpenAI embedding access, then run openclaw memory status --agent ${agentId} --deep.`,
    status: 'blocked',
  };
}

/** Own manifest-declared built-in memory configuration for one OpenClaw agent. */
export default function createMemoryLifecycleContribution(
  dependencies: MemoryLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'memory',
    isConfigured: (manifest) => manifest.memory !== undefined,
    validate: () => ({
      code: 'agent-memory-declaration-valid',
      summary: 'Agent memory search',
    }),
    async inspect(context) {
      const memory = context.manifest.memory;
      if (!memory) return [];
      const agentId = context.manifest.agent.id;
      const plan = createMemoryConfigurationPlan(await dependencies.readConfig(), agentId, memory);
      if (plan.status !== 'ready') return [planFinding(plan)];
      if (plan.changed) {
        return [
          {
            code: 'agent-memory-config-drift',
            message: `OpenClaw memory configuration for ${agentId} does not match the manifest.`,
            remediation: 'Run openclaw agent-system install from this workspace.',
            status: 'drift',
          },
        ];
      }

      if (memory.search.provider === 'openai' && memory.search.apiKey !== undefined) {
        const binding = await dependencies.inspectBinding({
          agentId,
          binding: memory.search.apiKey,
        });
        if (binding !== 'available') {
          return [
            {
              code:
                binding === 'missing'
                  ? 'agent-memory-credential-missing'
                  : 'agent-memory-credential-unavailable',
              message: `The declared memory credential binding for ${agentId} is ${binding}.`,
              remediation:
                'Restore the declared Agent System environment binding, then run doctor again.',
              status: 'blocked',
            },
          ];
        }
      }

      let status: MemoryStatus;
      try {
        status = await dependencies.inspectMemoryStatus({
          agentId,
          deep: memory.search.provider === 'openai',
          workspaceDir: context.workspaceDir,
        });
      } catch {
        if (memory.search.provider === 'local') return [localProviderSetupFinding(agentId)];
        return [
          {
            code: 'agent-memory-status-unavailable',
            message: `OpenClaw memory readiness evidence is unavailable for ${agentId}.`,
            remediation: `Restore openclaw memory status --agent ${agentId}, then run doctor again.`,
            status: 'blocked',
          },
        ];
      }

      const fts = ftsFinding(status.status, agentId);
      if (fts.length > 0) return fts;
      if (memory.search.provider === 'none') {
        return [
          {
            code: 'agent-memory-keyword-ready',
            message: `OpenClaw keyword memory search for ${agentId} matches the manifest.`,
            status: 'healthy',
          },
        ];
      }

      const provider = providerMismatchFinding(status.status, agentId, memory.search.provider);
      if (provider.length > 0) return provider;
      const index = indexFinding(status.status, agentId);
      if (index.length > 0) return index;

      if (memory.search.provider === 'local') {
        if (status.status.vector?.storeAvailable === false) {
          return providerMismatchFinding(
            { ...status.status, provider: 'unavailable' },
            agentId,
            'local',
          );
        }
        if (status.status.vector?.semanticAvailable === true) {
          return [
            {
              code: 'agent-memory-local-ready',
              message: `OpenClaw local memory search for ${agentId} matches the manifest and has verified semantic vectors.`,
              status: 'healthy',
            },
          ];
        }
        return [
          {
            code: 'agent-memory-local-unprobed',
            message: `OpenClaw local memory search for ${agentId} matches the manifest but has not been deeply probed.`,
            remediation: `Run openclaw memory status --agent ${agentId} --deep when local model initialization is acceptable.`,
            status: 'manual',
          },
        ];
      }

      const embeddingFailure = embeddingFailureFinding(status, agentId);
      if (embeddingFailure) return [embeddingFailure];
      if (
        status.status.vector?.storeAvailable === false ||
        status.status.vector?.semanticAvailable === false
      ) {
        return [
          {
            code: 'agent-memory-semantic-unavailable',
            message: `OpenClaw did not verify semantic memory search for ${agentId}.`,
            remediation: `Review openclaw memory status --agent ${agentId} --deep.`,
            status: 'blocked',
          },
        ];
      }
      return [
        {
          code: 'agent-memory-openai-ready',
          message: `OpenClaw OpenAI memory search for ${agentId} matches the manifest and passed its embedding probe.`,
          status: 'healthy',
        },
      ];
    },
    async reconcile(context) {
      const memory = context.manifest.memory;
      if (!memory) return { outcomes: [] };
      const agentId = context.manifest.agent.id;
      const plan = createMemoryConfigurationPlan(await dependencies.readConfig(), agentId, memory);
      if (plan.status !== 'ready') throw lifecycleError(planFinding(plan));
      if (!plan.changed) {
        return {
          outcomes: [
            {
              code: 'agent-memory-unchanged',
              message: `OpenClaw memory search for ${agentId}`,
              status: 'unchanged',
            },
          ],
        };
      }

      const mutation = await dependencies.mutateConfigFile({
        base: 'source',
        afterWrite: { mode: 'auto' },
        mutate(config) {
          const currentPlan = createMemoryConfigurationPlan(config, agentId, memory);
          if (currentPlan.status !== 'ready') throw lifecycleError(planFinding(currentPlan));
          if (!currentPlan.changed) return false;
          const agent = configuredAgentValue(config, agentId);
          const nextAgent = configuredAgentValue(currentPlan.config, agentId);
          if (!agent || !nextAgent) return false;
          agent.memory = structuredClone(nextAgent.memory);
          if (currentPlan.providerChanged) {
            config.secrets ??= {};
            config.secrets.providers ??= {};
            config.secrets.providers[memorySecretProviderAlias] = structuredClone(
              currentPlan.config.secrets!.providers![memorySecretProviderAlias]!,
            );
          }
          return true;
        },
      });

      const verification = createMemoryConfigurationPlan(
        await dependencies.readConfig(),
        agentId,
        memory,
      );
      if (verification.status !== 'ready' || verification.changed) {
        throw new AgentSystemLifecycleError(
          'memory',
          'agent-memory-verification-failed',
          `OpenClaw memory configuration for ${agentId} did not match the manifest after installation.`,
        );
      }

      return {
        outcomes: [
          mutation.result === true
            ? {
                code: 'set-agent-memory',
                message: `OpenClaw memory search for ${agentId}`,
                status: 'updated',
              }
            : {
                code: 'agent-memory-unchanged',
                message: `OpenClaw memory search for ${agentId}`,
                status: 'unchanged',
              },
        ],
      };
    },
  };
}
