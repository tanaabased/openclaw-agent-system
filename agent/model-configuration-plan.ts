import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { configuredAgentValue } from '../core/configured-agents.ts';
import type { AgentModelProfile, AgentModelsConfiguration } from '../manifest/models-schema.ts';

interface ModelRef {
  model: string;
  provider: string;
}

interface ModelProfileEntry {
  name: 'default' | 'high' | 'low' | 'medium';
  profile: AgentModelProfile;
}

export interface ModelConfigurationDependencies {
  resolveCliBackendDispatchEligibility(params: {
    agentId: string;
    config: OpenClawConfig;
    model: string;
    provider: string;
    workspaceDir: string;
  }): { provider: string } | undefined;
  resolveDefaultModelForAgent(params: { agentId: string; config: OpenClawConfig }): ModelRef;
  resolveAllowedModelRef(params: {
    agentId?: string;
    config: OpenClawConfig;
    defaultProvider: string;
    raw: string;
  }): { error: string } | { key: string; ref: ModelRef };
}

export type ReadyModelConfigurationPlan = {
  changed: boolean;
  config: OpenClawConfig;
  declared: ModelProfileEntry[];
  modelConfigurationChanged: boolean;
  selectionPolicy: {
    findingModels: string[];
    sourcePath: string;
  };
  sourceRuntime: string;
  status: 'ready';
};

export type ModelConfigurationPlan =
  ReadyModelConfigurationPlan | { message: string; status: 'conflict' | 'missing-agent' };

function modelProfiles(models: AgentModelsConfiguration): ModelProfileEntry[] {
  return [
    { name: 'default', profile: models.default },
    ...(models.low === undefined ? [] : [{ name: 'low' as const, profile: models.low }]),
    ...(models.medium === undefined ? [] : [{ name: 'medium' as const, profile: models.medium }]),
    ...(models.high === undefined ? [] : [{ name: 'high' as const, profile: models.high }]),
  ];
}

export function parseModelRef(value: string): ModelRef {
  const separator = value.indexOf('/');
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) };
}

export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export function sameRuntime(left: string, right: string): boolean {
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
  dependencies: ModelConfigurationDependencies,
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

function selectionPolicySource(
  config: OpenClawConfig,
  agentId: string,
): { agentId?: string; allow: string[]; path: string } {
  const agentAllow = configuredAgentValue(config, agentId)?.modelPolicy?.allow;
  if (agentAllow !== undefined) {
    return {
      agentId,
      allow: agentAllow,
      path: `agents.entries.${agentId}.modelPolicy.allow`,
    };
  }

  const defaultAllow = config.agents?.defaults?.modelPolicy?.allow;
  if (defaultAllow !== undefined) {
    return {
      allow: defaultAllow,
      path: 'agents.defaults.modelPolicy.allow',
    };
  }

  return {
    allow: Object.keys(config.agents?.defaults?.models ?? {}),
    path: 'agents.defaults.models',
  };
}

function missingModelSelections(
  config: OpenClawConfig,
  agentId: string,
  values: string[],
  dependencies: ModelConfigurationDependencies,
): string[] {
  return values.filter((value) => {
    const ref = parseModelRef(value);
    const resolved = dependencies.resolveAllowedModelRef({
      agentId,
      config,
      defaultProvider: ref.provider,
      raw: value,
    });
    return 'error' in resolved;
  });
}

function configureSelectionPolicy(
  config: OpenClawConfig,
  agentId: string,
  missing: string[],
  dependencies: ModelConfigurationDependencies,
): OpenClawConfig {
  if (missing.length === 0) return config;
  const prospective = structuredClone(config);
  const agent = configuredAgentValue(prospective, agentId);
  if (!agent) return config;
  const source = selectionPolicySource(config, agentId);
  const defaultProvider = parseModelRef(missing[0]!).provider;
  const allow: string[] = [];
  for (const raw of source.allow) {
    if (source.agentId !== undefined || raw.trim().endsWith('/*')) {
      if (!allow.includes(raw)) allow.push(raw);
      continue;
    }
    const resolved = dependencies.resolveAllowedModelRef({
      agentId: source.agentId,
      config,
      defaultProvider,
      raw,
    });
    if ('error' in resolved) continue;
    const value = modelKey(resolved.ref);
    if (!allow.includes(value)) allow.push(value);
  }
  for (const value of missing) {
    if (!allow.includes(value)) allow.push(value);
  }
  agent.modelPolicy = {
    ...agent.modelPolicy,
    allow,
  };
  return prospective;
}

/** Plan agent model configuration without mutating the supplied snapshot. */
export default function createConfigurationPlan(
  config: OpenClawConfig,
  agentId: string,
  models: AgentModelsConfiguration,
  dependencies: ModelConfigurationDependencies,
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
  const currentPolicyMissing = missingModelSelections(config, agentId, distinctRefs, dependencies);
  const policyFindingModels = currentPolicyMissing.filter((value) => {
    const runtime = configuredRuntime(config, agentId, parseModelRef(value));
    return (
      runtime !== undefined && !isDefaultRuntime(runtime) && sameRuntime(runtime, sourceRuntime)
    );
  });
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

  let modelConfigurationChanged = false;
  if (configuredPrimaryModel(agent.model) !== models.default.model) {
    configurePrimaryModel(nextAgent, models.default.model);
    modelConfigurationChanged = true;
  }
  if (agent.thinkingDefault !== models.default.effort) {
    nextAgent.thinkingDefault = models.default.effort;
    modelConfigurationChanged = true;
  }

  nextAgent.models ??= {};
  for (const value of distinctRefs) {
    const entry = agent.models?.[value];
    if (entry === undefined) {
      nextAgent.models[value] = { agentRuntime: { id: sourceRuntime } };
      modelConfigurationChanged = true;
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
      modelConfigurationChanged = true;
    }
  }

  const policyMissing = missingModelSelections(prospective, agentId, distinctRefs, dependencies);
  const policyConfig = configureSelectionPolicy(prospective, agentId, policyMissing, dependencies);

  return {
    changed: modelConfigurationChanged || policyMissing.length > 0,
    config: policyConfig,
    declared,
    modelConfigurationChanged,
    selectionPolicy: {
      findingModels: policyFindingModels,
      sourcePath: selectionPolicySource(config, agentId).path,
    },
    sourceRuntime,
    status: 'ready',
  };
}
