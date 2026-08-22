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

/** Retain the configured coding surface for trusted Work-mode turns. */
const githubNotificationWorkMode: GitHubNotificationMode = {
  policy: {
    id: 'work',
    toolProjection: { kind: 'inherit-configured', requiredProfile: 'coding' },
  },
  resolve(config: OpenClawConfig, agentId: string): ResolvedGitHubNotificationMode {
    if (effectiveProfile(config, agentId) !== 'coding') {
      throw new GitHubNotificationCapabilityError(
        'github-notification-work-capability-profile-mismatch',
      );
    }
    return { disableTools: false, id: 'work' };
  },
};

export default githubNotificationWorkMode;
