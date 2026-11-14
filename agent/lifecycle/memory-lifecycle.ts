import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { configuredAgentValue } from '../../core/configured-agents.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleFinding,
} from '../../core/lifecycle-registry.ts';
import createMemoryConfigurationPlan, {
  memorySecretProviderAlias,
  type MemoryConfigurationPlan,
  type ReadyMemoryConfigurationPlan,
} from './memory-configuration-plan.ts';
import { memorySecretId } from './memory-secret-provider-configuration.ts';
import type { MemoryEmbeddingStatus, MemoryIndexStatus } from './inspect-memory-status.ts';
import { nativeObject } from '../../utils/native-object.ts';
import type { AgentMemoryConfiguration } from '../../manifest/memory-schema.ts';
import {
  classifyMemoryEmbeddingFailure,
  memoryIndexState,
  type MemoryStatus,
} from './memory-status.ts';

export interface MemoryLifecycleDependencies {
  inspectMemoryIndex(params: { agentId: string; workspaceDir: string }): Promise<MemoryIndexStatus>;
  inspectMemoryEmbedding(params: {
    agentId: string;
    workspaceDir: string;
  }): Promise<MemoryEmbeddingStatus>;
  inspectBinding(params: {
    agentId: string;
    binding: string;
  }): Promise<'available' | 'missing' | 'unavailable'>;
  inspectConfiguredSecret(params: {
    config: OpenClawConfig;
    id: string;
  }): Promise<'available' | 'unavailable'>;
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  resolveSecretProviderConfiguration(
    config: OpenClawConfig,
  ): NonNullable<NonNullable<OpenClawConfig['secrets']>['providers']>[string];
}

type ContributionFinding = Omit<AgentSystemLifecycleFinding, 'component'>;

function planFinding(
  plan: Exclude<MemoryConfigurationPlan, ReadyMemoryConfigurationPlan>,
): ContributionFinding {
  return {
    code:
      plan.status === 'missing-agent'
        ? 'agent-memory-agent-missing'
        : plan.status === 'provider-unavailable'
          ? 'agent-memory-secret-provider-unavailable'
          : 'agent-memory-secret-provider-conflict',
    message: plan.message,
    remediation:
      plan.status === 'missing-agent'
        ? 'Run openclaw agent-system install from this workspace.'
        : plan.status === 'provider-unavailable'
          ? 'Build the linked Agent System checkout, verify its executable paths, then run install again.'
          : `Move or remove the conflicting ${memorySecretProviderAlias} secret provider, then run doctor again.`,
    status: plan.status === 'missing-agent' ? 'drift' : 'blocked',
  };
}

async function resolveMemoryConfigurationPlan(
  dependencies: MemoryLifecycleDependencies,
  config: OpenClawConfig,
  agentId: string,
  memory: AgentMemoryConfiguration,
): Promise<MemoryConfigurationPlan> {
  let secretProviderConfiguration;
  if (memory.search.provider === 'openai' && memory.search.apiKey !== undefined) {
    try {
      secretProviderConfiguration = dependencies.resolveSecretProviderConfiguration(config);
    } catch {
      return {
        message: `The Agent System memory secret provider is unavailable for ${agentId}.`,
        status: 'provider-unavailable',
      };
    }
  }
  return createMemoryConfigurationPlan(config, agentId, memory, secretProviderConfiguration);
}

function lifecycleError(finding: ContributionFinding): AgentSystemLifecycleError {
  return new AgentSystemLifecycleError('memory', finding.code, finding.message);
}

function indexFinding(status: MemoryStatus['status'], agentId: string): ContributionFinding[] {
  const state = memoryIndexState(status);
  const isEmptyUninitializedIndex =
    state === 'missing' && status.files === 0 && status.chunks === 0 && !status.lastSyncError;
  if (
    status.vector?.enabled === true &&
    status.vector.storeAvailable !== false &&
    !status.dirty &&
    !status.lastSyncError &&
    (isEmptyUninitializedIndex || state === 'complete' || state === 'empty')
  ) {
    return [];
  }
  return [
    {
      code: 'agent-memory-index-incomplete',
      message: `OpenClaw reports incomplete or incompatible memory index evidence for ${agentId}.`,
      remediation: `Review openclaw memory status --agent ${agentId} --deep, then run openclaw memory status --index --agent ${agentId} when a rebuild is appropriate.`,
      status: 'drift',
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
  probe: MemoryStatus['embeddingProbe'],
  agentId: string,
  provider: 'openai' | 'local',
): ContributionFinding | undefined {
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
    code: `agent-memory-${provider}-${classification}`,
    message: `OpenClaw reports that ${explanation} for ${agentId}.`,
    remediation: `Restore ${provider} embedding access, then run openclaw memory status --agent ${agentId} --deep.`,
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
      const config = await dependencies.readConfig();
      const plan = await resolveMemoryConfigurationPlan(dependencies, config, agentId, memory);
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

      const params = { agentId, workspaceDir: context.workspaceDir };
      const inspectIndex = async (): Promise<ContributionFinding[]> => {
        try {
          const status = await dependencies.inspectMemoryIndex(params);
          const fts = ftsFinding(status, agentId);
          if (fts.length) return fts;
          if (memory.search.provider !== 'none') {
            const index = indexFinding(status, agentId);
            if (index.length) return index;
          } else if (
            status.dirty ||
            status.lastSyncError ||
            ['mismatched', 'missing'].includes(memoryIndexState(status) ?? '')
          ) {
            return indexFinding(status, agentId);
          }
          // the online health manager does not initialize embeddings. Pending provider
          // state is not index damage; require independently complete index evidence.
          if (status.health === 'degraded') {
            const pending =
              memory.search.provider !== 'none' &&
              nativeObject(status.custom?.providerState) &&
              status.custom.providerState.mode === 'pending';
            const identity = status.custom?.indexIdentity;
            if (
              !pending ||
              status.dirty !== false ||
              !nativeObject(identity) ||
              identity.status !== 'valid'
            ) {
              throw new Error('Unexplained memory health degradation.');
            }
          }
          return [
            {
              code:
                memory.search.provider === 'none'
                  ? 'agent-memory-keyword-ready'
                  : 'agent-memory-index-ready',
              message: `OpenClaw memory index for ${agentId} is ready.`,
              status: 'healthy',
            },
          ];
        } catch {
          return [
            {
              code: 'agent-memory-index-unavailable',
              message: `OpenClaw memory index evidence is unavailable for ${agentId}.`,
              remediation: `Review OpenClaw memory status for ${agentId}, then run doctor again.`,
              status: 'blocked',
            },
          ];
        }
      };
      const inspectEmbedding = async (): Promise<ContributionFinding[]> => {
        if (memory.search.provider === 'none') return [];
        try {
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
            const configuredSecret = await dependencies.inspectConfiguredSecret({
              config,
              id: memorySecretId(agentId, memory.search.apiKey),
            });
            if (configuredSecret !== 'available') {
              return [
                {
                  code: 'agent-memory-credential-unresolved',
                  message: `OpenClaw could not resolve the configured memory credential for ${agentId}.`,
                  remediation:
                    'Restore the configured Agent System secret provider, reload OpenClaw, then run doctor again.',
                  status: 'blocked',
                },
              ];
            }
          }

          const embedding = await dependencies.inspectMemoryEmbedding(params);
          const failure = embeddingFailureFinding(embedding.probe, agentId, memory.search.provider);
          if (failure) return [failure];
          if (embedding.provider !== memory.search.provider || embedding.fallback) {
            return [
              memory.search.provider === 'local'
                ? localProviderSetupFinding(agentId)
                : {
                    code: 'agent-memory-provider-unavailable',
                    message: `OpenClaw did not activate the declared ${memory.search.provider} embedding provider for ${agentId}.`,
                    status: 'blocked',
                  },
            ];
          }
          return [
            {
              code: 'agent-memory-embedding-ready',
              message: `OpenClaw ${memory.search.provider} embeddings for ${agentId} passed their availability probe.`,
              status: 'healthy',
            },
          ];
        } catch {
          return [
            {
              code: 'agent-memory-embedding-unavailable',
              message: `OpenClaw embedding readiness evidence is unavailable for ${agentId}.`,
              remediation: `Review the configured embedding provider for ${agentId}, then run doctor again.`,
              status: 'blocked',
            },
          ];
        }
      };
      // keep both results even when one inspection fails. Offline readers run serially
      // because OpenClaw's CLI owns the same exclusive memory-store boundary.
      const index = await inspectIndex();
      const embedding = await inspectEmbedding();
      return [
        ...index.map((finding) => ({ ...finding, stepId: 'memory-index' })),
        ...embedding.map((finding) => ({ ...finding, stepId: 'memory-embedding' })),
      ];
    },
    async reconcile(context) {
      const memory = context.manifest.memory;
      if (!memory) return { outcomes: [] };
      const agentId = context.manifest.agent.id;
      const plan = await resolveMemoryConfigurationPlan(
        dependencies,
        await dependencies.readConfig(),
        agentId,
        memory,
      );
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
          const secretProviderConfiguration =
            plan.config.secrets?.providers?.[memorySecretProviderAlias];
          const currentPlan = createMemoryConfigurationPlan(
            config,
            agentId,
            memory,
            secretProviderConfiguration,
          );
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
