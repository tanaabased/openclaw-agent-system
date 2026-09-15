import { isDeepStrictEqual } from 'node:util';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { configuredAgentValue } from '../core/configured-agents.ts';
import type { AgentMemoryConfiguration } from '../manifest/memory-schema.ts';
import {
  isAgentSystemMemorySecretProvider,
  memorySecretId,
  memorySecretProviderAlias,
  type MemorySecretProviderConfiguration,
} from './memory-secret-provider-configuration.ts';

export {
  memorySecretId,
  memorySecretProviderAlias,
  memorySecretProviderIntegrationId,
} from './memory-secret-provider-configuration.ts';

export type ReadyMemoryConfigurationPlan = {
  changed: boolean;
  config: OpenClawConfig;
  memoryChanged: boolean;
  providerChanged: boolean;
  status: 'ready';
};

export type MemoryConfigurationPlan =
  | ReadyMemoryConfigurationPlan
  | { message: string; status: 'conflict' | 'missing-agent' | 'provider-unavailable' };

/** Plan per-agent memory configuration without mutating the supplied snapshot. */
export default function createMemoryConfigurationPlan(
  config: OpenClawConfig,
  agentId: string,
  memory: AgentMemoryConfiguration,
  secretProviderConfiguration?: MemorySecretProviderConfiguration,
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
  if (
    needsSecretProvider &&
    configuredProvider &&
    !isAgentSystemMemorySecretProvider(configuredProvider)
  ) {
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

  if (needsSecretProvider) {
    prospective.secrets ??= {};
    prospective.secrets.providers ??= {};
    prospective.secrets.providers[memorySecretProviderAlias] = structuredClone(
      secretProviderConfiguration ?? {
        source: 'exec',
        pluginIntegration: {
          pluginId: 'agent-system',
          integrationId: 'environment',
        },
      },
    );
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
