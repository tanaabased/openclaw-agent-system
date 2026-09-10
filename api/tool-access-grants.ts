import type AgentSystemToolRegistry from './registry.ts';
import type { AgentToolAccessGrants } from './plan-access.ts';
import type { AgentManifest } from '../manifest/types.ts';

const openClawGitHubToolNames = ['github_identity_status'] as const;

type ToolNameRegistry = Pick<AgentSystemToolRegistry, 'allToolNames' | 'configuredToolNames'>;

/** Combine Agent System tools with native OpenClaw tools required by configured projections. */
export default function createAgentToolAccessGrants(
  registry: ToolNameRegistry,
  manifest: AgentManifest,
): AgentToolAccessGrants {
  const githubToolNames = manifest.github === undefined ? [] : openClawGitHubToolNames;
  return {
    desired: [...registry.configuredToolNames(manifest), ...githubToolNames],
    owned: [...registry.allToolNames(), ...openClawGitHubToolNames],
  };
}
