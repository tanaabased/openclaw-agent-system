import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';

import type { GitHubNotificationReplyCandidateFinishInput } from './reply-candidate-store.ts';
import type { GitHubNotificationSelectedTurn } from '../conversation/turn-selector.ts';

export const githubNotificationReplyTurnBinding = 'agent-system.github-reply-turn';

/** Match the host-bound attempt to the current durable lifecycle descriptor. */
export function resolveGitHubNotificationReplyTurnBinding(
  context: OpenClawPluginToolContext,
  selected: GitHubNotificationSelectedTurn,
): GitHubNotificationReplyCandidateFinishInput | undefined {
  const value = context.toolBindings?.[githubNotificationReplyTurnBinding];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const binding = value as Partial<GitHubNotificationReplyCandidateFinishInput>;
  if (
    binding.agentId !== selected.agentId ||
    binding.conversationId !== selected.conversationId ||
    binding.sourceId !== selected.sourceId ||
    binding.identity?.eventId !== selected.identity.eventId ||
    binding.identity?.lifecycleId !== selected.identity.lifecycleId ||
    binding.identity?.modeId !== selected.identity.modeId ||
    typeof binding.turnId !== 'string' ||
    !binding.turnId ||
    binding.turnId.length > 128
  )
    return undefined;
  return { ...selected, turnId: binding.turnId };
}
