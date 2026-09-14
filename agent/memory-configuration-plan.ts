import { isDeepStrictEqual } from 'node:util';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { configuredAgentValue } from '../core/configured-agents.ts';
import type { AgentMemoryConfiguration } from '../manifest/memory-schema.ts';

export const memorySecretProviderAlias = 'agent-system-environment';
export const memorySecretProviderIntegrationId = 'environment';

export function memorySecretId(agentId: string, binding: string): string {
  return `agents/${agentId}/environment/${binding}`;
}

export type ReadyMemoryConfigurationPlan = {
  changed: boolean;
  config: OpenClawConfig;
  memoryChanged: boolean;
  providerChanged: boolean;
  status: 'ready';
};

export type MemoryConfigurationPlan =
  ReadyMemoryConfigurationPlan | { message: string; status: 'conflict' | 'missing-agent' };

function isManagedProvider(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const integration = Reflect.get(value, 'pluginIntegration');
  return (
    Reflect.get(value, 'source') === 'exec' &&
    integration !== null &&
    typeof integration === 'object' &&
    !Array.isArray(integration) &&
    Reflect.get(integration, 'pluginId') === 'agent-system' &&
    Reflect.get(integration, 'integrationId') === memorySecretProviderIntegrationId
  );
}

/** Plan per-agent memory configuration without mutating the supplied snapshot. */
export default function createMemoryConfigurationPlan(
  config: OpenClawConfig,
  agentId: string,
  memory: AgentMemoryConfiguration,
): MemoryConfigurationPlan {
  const agent = configuredAgentValue(config, agentId);
  if (!agent) {
    return {
      message: `OpenClaw memory configuration for ${agentId} cannot be managed until the agent is registered.`,
      status: 'missing-agent',
    };
  }

  const needsSecretProvider =
    memory.search.provider === 'openai' && memory.search.apiKey !== undefined;
  const configuredProvider = config.secrets?.providers?.[memorySecretProviderAlias];
  if (needsSecretProvider && configuredProvider && !isManagedProvider(configuredProvider)) {
    return {
      message: `OpenClaw secret provider ${memorySecretProviderAlias} is already owned by another configuration.`,
      status: 'conflict',
    };
  }

  const prospective = structuredClone(config);
  const nextAgent = configuredAgentValue(prospective, agentId);
  if (!nextAgent) {
    return {
      message: `OpenClaw memory configuration for ${agentId} cannot be managed until the agent is registered.`,
      status: 'missing-agent',
    };
  }

  const currentSearch = agent.memory?.search ?? {};
  const nextSearch = structuredClone(currentSearch);
  nextSearch.provider = memory.search.provider;
  nextSearch.fallback = 'none';

  if (memory.search.provider === 'openai' && memory.search.model !== undefined) {
    nextSearch.model = memory.search.model;
  } else {
    delete nextSearch.model;
  }

  const nextRemote = structuredClone(currentSearch.remote ?? {});
  if (memory.search.provider === 'openai' && memory.search.apiKey !== undefined) {
    nextRemote.apiKey = {
      source: 'exec',
      provider: memorySecretProviderAlias,
      id: memorySecretId(agentId, memory.search.apiKey),
    };
  } else {
    delete nextRemote.apiKey;
  }
  if (Object.keys(nextRemote).length > 0) nextSearch.remote = nextRemote;
  else delete nextSearch.remote;

  nextAgent.memory = {
    ...nextAgent.memory,
    search: nextSearch,
  };

  if (needsSecretProvider && configuredProvider === undefined) {
    prospective.secrets ??= {};
    prospective.secrets.providers ??= {};
    prospective.secrets.providers[memorySecretProviderAlias] = {
      source: 'exec',
      pluginIntegration: {
        pluginId: 'agent-system',
        integrationId: memorySecretProviderIntegrationId,
      },
    };
  }

  const memoryChanged = !isDeepStrictEqual(agent.memory?.search, nextAgent.memory.search);
  const providerChanged = !isDeepStrictEqual(
    config.secrets?.providers?.[memorySecretProviderAlias],
    prospective.secrets?.providers?.[memorySecretProviderAlias],
  );
  return {
    changed: memoryChanged || providerChanged,
    config: prospective,
    memoryChanged,
    providerChanged,
    status: 'ready',
  };
}
