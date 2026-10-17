import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { configuredAgentValue } from '../core/configured-agents.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { configuredRuntime, parseModelRef, sameRuntime } from './model-configuration-plan.ts';

function selectedModels(
  model: string | { primary?: string; fallbacks?: string[] } | undefined,
): string[] {
  if (typeof model === 'string') return [model];
  return [model?.primary, ...(model?.fallbacks ?? [])].filter((value): value is string => !!value);
}

/** Decide from this agent's effective bindings, without loading the Codex plugin. */
export default function codexPluginApplies(
  manifest: AgentManifest,
  readConfig: () => OpenClawConfig,
): boolean {
  if (manifest.agent.runtime === 'codex') return true;
  const config = readConfig();
  const agent = configuredAgentValue(config, manifest.agent.id);
  const defaults = config.agents?.defaults;
  const refs = new Set([
    ...selectedModels(agent?.model),
    ...selectedModels(defaults?.model),
    ...Object.keys(agent?.models ?? {}),
    ...Object.keys(defaults?.models ?? {}),
    ...(manifest.models ? Object.values(manifest.models).map(({ model }) => model) : []),
  ]);
  for (const value of refs) {
    const [provider, model] = value.split('/', 2);
    if (!provider || !model) continue;
    const ref = parseModelRef(model === '*' ? `${provider}/__agent_system_runtime_probe__` : value);
    const runtime = configuredRuntime(config, manifest.agent.id, ref);
    if (runtime && sameRuntime(runtime, 'codex')) return true;
  }
  return false;
}
