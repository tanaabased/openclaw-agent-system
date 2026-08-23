import { listAgentEntries } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { GitHubNotificationMode, ResolvedGitHubNotificationMode } from './types.ts';

export class GitHubNotificationCapabilityError extends Error {
  override name = 'GitHubNotificationCapabilityError';

  constructor(readonly code: string) {
    super('The GitHub notification capability is unavailable.');
  }
}

function effectiveProfile(config: OpenClawConfig, agentId: string) {
  const normalized = agentId.trim().toLowerCase();
  const agent = listAgentEntries(config).find(({ id }) => id.trim().toLowerCase() === normalized);
  return agent?.tools?.profile ?? config.tools?.profile;
}

/** Resolve one trusted mode declaration into enforced model-tool options. */
export default function resolveGitHubNotificationModeCapability(
  mode: GitHubNotificationMode,
  config: OpenClawConfig,
  agentId: string,
): ResolvedGitHubNotificationMode {
  const projection = mode.policy.toolProjection;
  if (projection.kind === 'allowlist') {
    const toolsAllow = [...projection.tools];
    return {
      disableTools: toolsAllow.length === 0,
      id: mode.policy.id,
      ...(toolsAllow.length === 0 ? {} : { toolsAllow }),
    };
  }
  if (effectiveProfile(config, agentId) !== projection.requiredProfile) {
    throw new GitHubNotificationCapabilityError(
      `github-notification-${mode.policy.id}-capability-profile-mismatch`,
    );
  }
  return { disableTools: false, id: mode.policy.id };
}
