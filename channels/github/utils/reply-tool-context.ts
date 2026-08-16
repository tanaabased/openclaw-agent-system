import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { normalizeAgentId, parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';

import { githubNotificationChannelId } from './routing.ts';

type GitHubNotificationReplyToolContext = OpenClawPluginToolContext & { agentId: string };

/** Admit the explicit channel context or the exact Codex notification session route. */
export default function isGitHubNotificationReplyToolContext(
  context: OpenClawPluginToolContext | undefined,
): context is GitHubNotificationReplyToolContext {
  if (!context) return false;
  const rawAgentId = context.agentId?.trim();
  if (!rawAgentId) return false;

  const explicitChannels = [context.messageChannel, context.deliveryContext?.channel]
    .map((channel) => channel?.trim())
    .filter((channel): channel is string => Boolean(channel));
  if (explicitChannels.length > 0) {
    return explicitChannels.every((channel) => channel === githubNotificationChannelId);
  }

  const parsed = parseAgentSessionKey(context.sessionKey);
  const agentId = normalizeAgentId(rawAgentId);
  if (!parsed || parsed.agentId !== agentId) return false;

  const segments = parsed.rest.split(':');
  const [channel, accountId, conversationKind, provider, itemType, repositoryNodeId, itemNumber] =
    segments;
  return (
    segments.length === 7 &&
    channel === githubNotificationChannelId &&
    accountId === agentId &&
    conversationKind === 'direct' &&
    provider === 'github' &&
    itemType === 'issue' &&
    Boolean(repositoryNodeId) &&
    /^[1-9]\d*$/u.test(itemNumber ?? '')
  );
}
