import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { configuredAgentValue } from '../core/configured-agents.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleFinding,
} from '../core/lifecycle-registry.ts';
import type { AgentModelProfile, AgentModelsConfiguration } from '../manifest/models-schema.ts';

interface ModelRef {
  model: string;
  provider: string;
}

interface ModelProfileEntry {
  name: 'default' | 'high' | 'low' | 'medium';
  profile: AgentModelProfile;
}

interface ModelCatalogRow {
  available: boolean | null;
  key: string;
  missing: boolean;
}

export interface ModelLifecycleDependencies {
  inspectModelCatalog(params: {
    agentId: string;
    provider: string;
    workspaceDir: string;
  }): Promise<ModelCatalogRow[]>;
  mutateConfigFile(params: {
    afterWrite: { mode: 'auto' };
    base: 'source';
    mutate(config: OpenClawConfig): boolean | void;
  }): Promise<{ result?: boolean }>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  resolveCliBackendDispatchEligibility(params: {
    agentId: string;
    config: OpenClawConfig;
    model: string;
    provider: string;
    workspaceDir: string;
  }): { provider: string } | undefined;
  resolveDefaultModelForAgent(params: { agentId: string; config: OpenClawConfig }): ModelRef;
  resolveThinkingPolicy(params: { agentRuntime: string; model: string; provider: string }): {
    levels: Array<{ id: string }>;
  };
  verifyProviderAuth(params: {
    config: OpenClawConfig;
    provider: string;
    workspaceDir: string;
  }): Promise<void>;
}

type ReadyModelConfigurationPlan = {
  changed: boolean;
  config: OpenClawConfig;
  declared: ModelProfileEntry[];
  sourceModel: ModelRef;
  sourceRuntime: string;
  status: 'ready';
};

type ModelConfigurationPlan =
  ReadyModelConfigurationPlan | { message: string; status: 'conflict' | 'missing-agent' };

type ContributionFinding = Omit<AgentSystemLifecycleFinding, 'component'>;

function modelProfiles(models: AgentModelsConfiguration): ModelProfileEntry[] {
  return [
    { name: 'default', profile: models.default },
    ...(models.low === undefined ? [] : [{ name: 'low' as const, profile: models.low }]),
    ...(models.medium === undefined ? [] : [{ name: 'medium' as const, profile: models.medium }]),
    ...(models.high === undefined ? [] : [{ name: 'high' as const, profile: models.high }]),
  ];
}

function parseModelRef(value: string): ModelRef {
  const separator = value.indexOf('/');
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

function sameRuntime(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function configuredRuntime(
  config: OpenClawConfig,
  agentId: string,
  ref: ModelRef,
): string | undefined {
  const provider = ref.provider.toLowerCase();
  const matchesModel = (value: string) => {
    const separator = value.indexOf('/');
    if (separator < 0) return value === ref.model;
    return (
      value.slice(0, separator).toLowerCase() === provider &&
      value.slice(separator + 1) === ref.model
    );
  };
  const matchesWildcard = (value: string) => {
    const separator = value.indexOf('/');
    return (
      separator > 0 &&
      value.slice(0, separator).toLowerCase() === provider &&
      value.slice(separator + 1) === '*'
    );
  };
  const runtimeFromMap = (
    models: Record<string, { agentRuntime?: { id?: string } }> | undefined,
    matches: (value: string) => boolean,
  ) =>
    Object.entries(models ?? {})
      .find(([value, entry]) => matches(value) && entry.agentRuntime?.id)?.[1]
      .agentRuntime?.id?.trim();
  const agentModels = configuredAgentValue(config, agentId)?.models;
  const defaultModels = config.agents?.defaults?.models;
  const exact =
    runtimeFromMap(agentModels, matchesModel) ?? runtimeFromMap(defaultModels, matchesModel);
  if (exact) return exact;

  const providerEntry = Object.entries(config.models?.providers ?? {}).find(
    ([id]) => id.toLowerCase() === provider,
  )?.[1];
  const providerModel = providerEntry?.models.find(({ id }) => matchesModel(id));
  const modelRuntime = providerModel?.agentRuntime?.id?.trim();
  if (modelRuntime) return modelRuntime;

  return (
    runtimeFromMap(agentModels, matchesWildcard) ??
    runtimeFromMap(defaultModels, matchesWildcard) ??
    providerEntry?.agentRuntime?.id?.trim()
  );
}

function isDefaultRuntime(runtime: string): boolean {
  const normalized = runtime.trim().toLowerCase();
  return normalized === 'auto' || normalized === 'default';
}

function resolveSourceRuntime(
  config: OpenClawConfig,
  agentId: string,
  sourceModel: ModelRef,
  dependencies: ModelLifecycleDependencies,
): { runtime: string; status: 'ready' } | { message: string; status: 'conflict' } {
  const eligible = dependencies.resolveCliBackendDispatchEligibility({
    agentId,
    config,
    model: sourceModel.model,
    provider: sourceModel.provider,
    workspaceDir: configuredAgentValue(config, agentId)?.workspace?.trim() ?? '',
  });
  const explicit = configuredRuntime(config, agentId, sourceModel);
  if (eligible) {
    if (explicit && !isDefaultRuntime(explicit) && !sameRuntime(explicit, eligible.provider)) {
      return {
        message: `OpenClaw resolved ${modelKey(sourceModel)} through runtime ${eligible.provider}, which conflicts with its ${explicit} binding.`,
        status: 'conflict',
      };
    }
    return { runtime: eligible.provider, status: 'ready' };
  }
  if (explicit && !isDefaultRuntime(explicit)) {
    return { runtime: explicit, status: 'ready' };
  }
  return { runtime: 'openclaw', status: 'ready' };
}

function configuredPrimaryModel(
  model: NonNullable<ReturnType<typeof configuredAgentValue>>['model'],
): string | undefined {
  return typeof model === 'string' ? model : model?.primary;
}

function configurePrimaryModel(
  agent: NonNullable<ReturnType<typeof configuredAgentValue>>,
  model: string,
): void {
  agent.model =
    agent.model !== null && typeof agent.model === 'object'
      ? { ...agent.model, primary: model }
      : model;
}

function createConfigurationPlan(
  config: OpenClawConfig,
  agentId: string,
  models: AgentModelsConfiguration,
  dependencies: ModelLifecycleDependencies,
): ModelConfigurationPlan {
  const agent = configuredAgentValue(config, agentId);
  if (!agent) {
    return {
      message: `OpenClaw model configuration for ${agentId} cannot be managed until the agent is registered.`,
      status: 'missing-agent',
    };
  }

  const sourceModel = dependencies.resolveDefaultModelForAgent({ agentId, config });
  const sourceResolution = resolveSourceRuntime(config, agentId, sourceModel, dependencies);
  if (sourceResolution.status !== 'ready') return sourceResolution;
  const sourceRuntime = sourceResolution.runtime;

  const declared = modelProfiles(models);
  const distinctRefs = [...new Set(declared.map(({ profile }) => profile.model))];
  for (const value of distinctRefs) {
    const ref = parseModelRef(value);
    const explicitRuntime = configuredRuntime(config, agentId, ref);
    if (!explicitRuntime) {
      const eligible = dependencies.resolveCliBackendDispatchEligibility({
        agentId,
        config,
        model: ref.model,
        provider: ref.provider,
        workspaceDir: agent.workspace?.trim() ?? '',
      });
      if (eligible && !sameRuntime(eligible.provider, sourceRuntime)) {
        return {
          message: `OpenClaw resolves ${value} through runtime ${eligible.provider} instead of the existing ${sourceRuntime} route.`,
          status: 'conflict',
        };
      }
      continue;
    }
    if (isDefaultRuntime(explicitRuntime)) {
      return {
        message: `OpenClaw model ${value} has an ambiguous ${explicitRuntime} runtime binding instead of the verified ${sourceRuntime} route.`,
        status: 'conflict',
      };
    }
    if (!sameRuntime(explicitRuntime, sourceRuntime)) {
      return {
        message: `OpenClaw model ${value} explicitly uses runtime ${explicitRuntime} instead of the existing ${sourceRuntime} route.`,
        status: 'conflict',
      };
    }
  }

  const prospective = structuredClone(config);
  const nextAgent = configuredAgentValue(prospective, agentId);
  if (!nextAgent) {
    return {
      message: `OpenClaw model configuration for ${agentId} cannot be managed until the agent is registered.`,
      status: 'missing-agent',
    };
  }

  let changed = false;
  if (configuredPrimaryModel(agent.model) !== models.default.model) {
    configurePrimaryModel(nextAgent, models.default.model);
    changed = true;
  }
  if (agent.thinkingDefault !== models.default.effort) {
    nextAgent.thinkingDefault = models.default.effort;
    changed = true;
  }

  nextAgent.models ??= {};
  for (const value of distinctRefs) {
    const entry = agent.models?.[value];
    if (entry === undefined) {
      nextAgent.models[value] = { agentRuntime: { id: sourceRuntime } };
      changed = true;
      continue;
    }
    if (!entry.agentRuntime?.id?.trim()) {
      nextAgent.models[value] = {
        ...nextAgent.models[value],
        agentRuntime: {
          ...nextAgent.models[value]?.agentRuntime,
          id: sourceRuntime,
        },
      };
      changed = true;
    }
  }

  return {
    changed,
    config: prospective,
    declared,
    sourceModel,
    sourceRuntime,
    status: 'ready',
  };
}

async function runtimeFinding(
  params: {
    agentId: string;
    config: OpenClawConfig;
    ref: ModelRef;
    runtime: string;
    workspaceDir: string;
  },
  dependencies: ModelLifecycleDependencies,
): Promise<ContributionFinding | undefined> {
  if (sameRuntime(params.runtime, 'openclaw')) {
    try {
      await dependencies.verifyProviderAuth({
        config: params.config,
        provider: params.ref.provider,
        workspaceDir: params.workspaceDir,
      });
      return;
    } catch {
      return {
        code: 'agent-model-runtime-auth-unavailable',
        message: `OpenClaw runtime authentication is unavailable for ${modelKey(params.ref)}.`,
        remediation: 'Repair the existing provider authentication, then run doctor again.',
        status: 'blocked',
      };
    }
  }

  const eligibility = dependencies.resolveCliBackendDispatchEligibility({
    agentId: params.agentId,
    config: params.config,
    model: params.ref.model,
    provider: params.ref.provider,
    workspaceDir: params.workspaceDir,
  });
  if (eligibility && sameRuntime(eligibility.provider, params.runtime)) return;
  return {
    code: 'agent-model-runtime-auth-unavailable',
    message: `Native runtime ${params.runtime} is not ready for ${modelKey(params.ref)} with subscription authentication.`,
    remediation:
      'Repair the existing native runtime or its stored authentication, then run doctor again.',
    status: 'blocked',
  };
}

async function readinessFindings(
  plan: ReadyModelConfigurationPlan,
  agentId: string,
  workspaceDir: string,
  dependencies: ModelLifecycleDependencies,
): Promise<ContributionFinding[]> {
  const sourceFinding = await runtimeFinding(
    {
      agentId,
      config: plan.config,
      ref: plan.sourceModel,
      runtime: plan.sourceRuntime,
      workspaceDir,
    },
    dependencies,
  );
  if (sourceFinding) return [sourceFinding];

  const declaredRefs = [...new Set(plan.declared.map(({ profile }) => profile.model))].map(
    parseModelRef,
  );
  const findings: ContributionFinding[] = [];
  for (const ref of declaredRefs) {
    const routeFinding = await runtimeFinding(
      {
        agentId,
        config: plan.config,
        ref,
        runtime: plan.sourceRuntime,
        workspaceDir,
      },
      dependencies,
    );
    if (routeFinding) findings.push(routeFinding);
  }

  const catalogRows = new Map<string, ModelCatalogRow>();
  const failedProviders = new Set<string>();
  for (const provider of new Set(declaredRefs.map(({ provider }) => provider))) {
    try {
      for (const row of await dependencies.inspectModelCatalog({
        agentId,
        provider,
        workspaceDir,
      })) {
        catalogRows.set(row.key, row);
      }
    } catch {
      failedProviders.add(provider);
    }
  }
  for (const ref of declaredRefs) {
    const value = modelKey(ref);
    if (failedProviders.has(ref.provider)) {
      findings.push({
        code: 'agent-model-capability-evidence-unavailable',
        message: `Capability evidence is unavailable for ${value}.`,
        remediation: 'Restore model catalog discovery, then run doctor again.',
        status: 'blocked',
      });
      continue;
    }
    const row = catalogRows.get(value);
    if (!row || row.missing || row.available === false) {
      findings.push({
        code: 'agent-model-unavailable',
        message: `OpenClaw does not report ${value} as an available model.`,
        remediation: 'Choose an available model or repair its provider installation.',
        status: 'blocked',
      });
    } else if (row.available === null) {
      findings.push({
        code: 'agent-model-capability-evidence-unavailable',
        message: `Capability evidence is unavailable for ${value}.`,
        remediation: 'Restore model catalog discovery, then run doctor again.',
        status: 'blocked',
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

/** Own manifest-declared model defaults and readiness for one bound OpenClaw agent. */
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
      const readiness = await readinessFindings(
        plan,
        context.manifest.agent.id,
        context.workspaceDir,
        dependencies,
      );
      return [
        ...readiness,
        ...(plan.changed
          ? [
              {
                code: 'agent-model-config-drift',
                message: `OpenClaw model defaults for ${context.manifest.agent.id} do not match the manifest.`,
                remediation: 'Run openclaw agent-system install from this workspace.',
                status: 'drift' as const,
              },
            ]
          : readiness.length === 0
            ? [
                {
                  code: 'agent-models-ready',
                  message: `OpenClaw model defaults and readiness for ${context.manifest.agent.id} match the manifest.`,
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
      const readiness = await readinessFindings(plan, agentId, context.workspaceDir, dependencies);
      if (readiness.length > 0) throw lifecycleError(readiness[0]!);
      if (!plan.changed) {
        return {
          outcomes: [
            {
              code: 'agent-models-unchanged',
              message: `OpenClaw model defaults and readiness for ${agentId}`,
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
      const verifiedReadiness = await readinessFindings(
        verification,
        agentId,
        context.workspaceDir,
        dependencies,
      );
      if (verifiedReadiness.length > 0) throw lifecycleError(verifiedReadiness[0]!);

      return {
        outcomes: [
          mutation.result === true
            ? {
                code: 'set-agent-models',
                message: `OpenClaw model defaults and readiness for ${agentId}`,
                status: 'updated' as const,
              }
            : {
                code: 'agent-models-unchanged',
                message: `OpenClaw model defaults and readiness for ${agentId}`,
                status: 'unchanged' as const,
              },
        ],
      };
    },
  };
}
