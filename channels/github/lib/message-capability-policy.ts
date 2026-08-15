import type { GitHubNotificationCapabilityId } from './message-registry.ts';

export interface GitHubNotificationCapabilityPolicy {
  disableTools: boolean;
  toolsAllow: string[];
}

/** Resolve the enforced runtime capability for the currently implemented message profile. */
export default function githubNotificationCapabilityPolicy(
  capability: GitHubNotificationCapabilityId,
): GitHubNotificationCapabilityPolicy {
  if (capability !== 'tool-free') {
    throw new Error(`GitHub notification ${capability} does not dispatch a model turn.`);
  }
  return { disableTools: true, toolsAllow: [] };
}
