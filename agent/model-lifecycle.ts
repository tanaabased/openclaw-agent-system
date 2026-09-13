import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { configuredAgentValue } from '../core/configured-agents.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleFinding,
} from '../core/lifecycle-registry.ts';
import createConfigurationPlan, {
  modelKey,
  parseModelRef,
  sameRuntime,
  type ModelConfigurationDependencies,
  type ModelConfigurationPlan,
  type ReadyModelConfigurationPlan,
} from './model-configuration-plan.ts';

interface ModelListRow {
  available: boolean | null;
  key: string;
  missing: boolean;
}

export interface ModelLifecycleDependencies extends ModelConfigurationDependencies {
  inspectConfiguredModels(params: {
    agentId: string;
    workspaceDir: string;
  }): Promise<ModelListRow[]>;
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  resolveThinkingPolicy(params: { agentRuntime: string; model: string; provider: string }): {
    levels: Array<{ id: string }>;
  };
}

type ContributionFinding = Omit<AgentSystemLifecycleFinding, 'component'>;

async function modelFindings(
  plan: ReadyModelConfigurationPlan,
  agentId: string,
  workspaceDir: string,
  dependencies: ModelLifecycleDependencies,
): Promise<ContributionFinding[]> {
  const declaredRefs = [...new Set(plan.declared.map(({ profile }) => profile.model))].map(
    parseModelRef,
  );
  const findings: ContributionFinding[] = [];
  let configuredModels: Map<string, ModelListRow>;
  try {
    configuredModels = new Map(
      (await dependencies.inspectConfiguredModels({ agentId, workspaceDir })).map((row) => [
        row.key,
        row,
      ]),
    );
  } catch {
    return [
      {
        code: 'agent-model-catalog-evidence-unavailable',
        message: `Configured model evidence is unavailable for ${agentId}.`,
        remediation: 'Restore model listing, then run doctor again.',
        status: 'blocked',
      },
    ];
  }
  for (const ref of declaredRefs) {
    const value = modelKey(ref);
    const row = configuredModels.get(value);
    if (!row || row.missing) {
      findings.push({
        code: 'agent-model-missing',
        message: `OpenClaw does not report ${value} in the configured model list for ${agentId}.`,
        remediation: 'Choose a known model or repair its provider installation.',
        status: 'blocked',
      });
    } else if (row.available === false) {
      findings.push({
        code: 'agent-model-unavailable',
        message: `OpenClaw does not currently report ${value} as available for ${agentId}.`,
        remediation: `Review openclaw models status --agent ${agentId} before relying on this model.`,
        status: 'warning',
      });
    }
  }

  for (const { name, profile } of plan.declared) {
    const ref = parseModelRef(profile.model);
    let supported: boolean;
    try {
      supported = dependencies
        .resolveThinkingPolicy({
          agentRuntime: plan.sourceRuntime,
          model: ref.model,
          provider: ref.provider,
        })
        .levels.some(({ id }) => id === profile.effort);
    } catch {
      findings.push({
        code: 'agent-model-capability-evidence-unavailable',
        message: `Effort capability evidence is unavailable for profile ${name} (${profile.model}).`,
        remediation: 'Restore model capability inspection, then run doctor again.',
        status: 'blocked',
      });
      continue;
    }
    if (!supported) {
      findings.push({
        code: 'agent-model-effort-unsupported',
        message: `Model profile ${name} requests effort ${profile.effort}, which ${profile.model} does not support through runtime ${plan.sourceRuntime}.`,
        remediation: 'Choose an effort supported by the selected model and runtime.',
        status: 'blocked',
      });
    }
  }
  return findings;
}

function planFinding(plan: Exclude<ModelConfigurationPlan, ReadyModelConfigurationPlan>) {
  return {
    code:
      plan.status === 'missing-agent'
        ? 'agent-model-agent-missing'
        : 'agent-model-runtime-conflict',
    message: plan.message,
    remediation:
      plan.status === 'missing-agent'
        ? 'Run openclaw agent-system install from this workspace.'
        : 'Resolve the conflicting runtime binding, then run doctor again.',
    status: plan.status === 'missing-agent' ? ('drift' as const) : ('blocked' as const),
  };
}

function lifecycleError(finding: ContributionFinding): AgentSystemLifecycleError {
  return new AgentSystemLifecycleError('models', finding.code, finding.message);
}

/** Own manifest-declared model configuration for one bound OpenClaw agent. */
export default function createModelLifecycleContribution(
  dependencies: ModelLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'models',
    isConfigured: (manifest) => manifest.models !== undefined,
    validate: () => ({
      code: 'agent-model-declaration-valid',
      summary: 'Agent model profiles',
    }),
    async inspect(context) {
      const models = context.manifest.models;
      if (!models) return [];
      const plan = createConfigurationPlan(
        await dependencies.readConfig(),
        context.manifest.agent.id,
        models,
        dependencies,
      );
      if (plan.status !== 'ready') return [planFinding(plan)];
      const findings = await modelFindings(
        plan,
        context.manifest.agent.id,
        context.workspaceDir,
        dependencies,
      );
      const policyFindings = plan.selectionPolicy.findingModels.map((model) => ({
        code: 'agent-model-selection-policy-drift',
        message: `OpenClaw model policy ${plan.selectionPolicy.sourcePath} does not allow ${model} for ${context.manifest.agent.id}.`,
        remediation: 'Run openclaw agent-system install from this workspace.',
        status: 'drift' as const,
      }));
      return [
        ...findings,
        ...policyFindings,
        ...(plan.modelConfigurationChanged
          ? [
              {
                code: 'agent-model-config-drift',
                message: `OpenClaw model defaults for ${context.manifest.agent.id} do not match the manifest.`,
                remediation: 'Run openclaw agent-system install from this workspace.',
                status: 'drift' as const,
              },
            ]
          : findings.length === 0 && policyFindings.length === 0
            ? [
                {
                  code: 'agent-models-ready',
                  message: `OpenClaw model configuration for ${context.manifest.agent.id} matches the manifest.`,
                  status: 'healthy' as const,
                },
              ]
            : []),
      ];
    },
    async reconcile(context) {
      const models = context.manifest.models;
      if (!models) return { outcomes: [] };
      const agentId = context.manifest.agent.id;
      const plan = createConfigurationPlan(
        await dependencies.readConfig(),
        agentId,
        models,
        dependencies,
      );
      if (plan.status !== 'ready') throw lifecycleError(planFinding(plan));
      if (!plan.changed) {
        return {
          outcomes: [
            {
              code: 'agent-models-unchanged',
              message: `OpenClaw model defaults for ${agentId}`,
              status: 'unchanged',
            },
          ],
        };
      }

      const expectedRuntime = plan.sourceRuntime;
      const mutation = await dependencies.mutateConfigFile({
        base: 'source',
        afterWrite: { mode: 'auto' },
        mutate(config) {
          const currentPlan = createConfigurationPlan(config, agentId, models, dependencies);
          if (currentPlan.status !== 'ready') throw lifecycleError(planFinding(currentPlan));
          if (!sameRuntime(currentPlan.sourceRuntime, expectedRuntime)) {
            throw lifecycleError({
              code: 'agent-model-source-route-changed',
              message: `OpenClaw runtime routing for ${agentId} changed during model installation.`,
              status: 'blocked',
            });
          }
          if (!currentPlan.changed) return false;
          const agent = configuredAgentValue(config, agentId);
          const nextAgent = configuredAgentValue(currentPlan.config, agentId);
          if (!agent || !nextAgent) return false;
          agent.model = structuredClone(nextAgent.model);
          agent.thinkingDefault = nextAgent.thinkingDefault;
          agent.models = structuredClone(nextAgent.models);
          agent.modelPolicy = structuredClone(nextAgent.modelPolicy);
          return true;
        },
      });

      const verification = createConfigurationPlan(
        await dependencies.readConfig(),
        agentId,
        models,
        dependencies,
      );
      if (verification.status !== 'ready' || verification.changed) {
        throw new AgentSystemLifecycleError(
          'models',
          'agent-model-verification-failed',
          `OpenClaw model defaults for ${agentId} did not match the manifest after installation.`,
        );
      }

      return {
        outcomes: [
          mutation.result === true
            ? {
                code: 'set-agent-models',
                message: `OpenClaw model defaults for ${agentId}`,
                status: 'updated' as const,
              }
            : {
                code: 'agent-models-unchanged',
                message: `OpenClaw model defaults for ${agentId}`,
                status: 'unchanged' as const,
              },
        ],
      };
    },
  };
}
