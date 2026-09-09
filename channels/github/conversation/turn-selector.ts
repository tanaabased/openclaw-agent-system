import { isAbsolute, resolve } from 'node:path';

import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';

import type { AgentSystemHookContext } from '../../../core/agent-hook-context.ts';
import type { Logger } from '../../../core/logger.ts';
import { githubNotificationChannelId } from '../routing/routing.ts';
import type { GitHubNotificationConversationState } from './conversation-state.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type { GitHubNotificationTurnDefinition } from './turn-catalog.ts';
import type { GitHubNotificationTurnIdentity } from './turn-identity.ts';

export interface GitHubNotificationTurnSelectorDependencies {
  conversations: Pick<GitHubNotificationConversationStateStore, 'read'>;
  logger: Pick<Logger, 'warn'>;
  turns: {
    resolve(
      identity: GitHubNotificationTurnIdentity,
    ): Pick<GitHubNotificationTurnDefinition, 'identity'>;
  };
}

export interface GitHubNotificationSelectedTurn {
  agentId: string;
  conversationId: string;
  identity: Readonly<GitHubNotificationTurnIdentity>;
  sourceId: string;
}

function normalizedAgentId(context: AgentSystemHookContext): string | undefined {
  const agentId = context.agentId?.trim().toLowerCase();
  return agentId && /^[a-z0-9][a-z0-9-]*$/u.test(agentId) ? agentId : undefined;
}

function sessionConversationId(
  context: AgentSystemHookContext,
  agentId: string,
): string | undefined {
  const parsed = context.sessionKey ? parseAgentSessionKey(context.sessionKey) : null;
  if (!parsed || parsed.agentId.toLowerCase() !== agentId) return undefined;
  const parts = parsed.rest.split(':');
  if (
    parts[0]?.toLowerCase() !== githubNotificationChannelId ||
    parts[1]?.toLowerCase() !== agentId ||
    (parts[2]?.toLowerCase() !== 'direct' && parts[2]?.toLowerCase() !== 'dm')
  ) {
    return undefined;
  }
  const selected = parts.slice(3).join(':').trim();
  return selected || undefined;
}

function conversationId(context: AgentSystemHookContext, agentId: string): string | undefined {
  const channelOwnedId = context.channelContext?.chat?.id?.trim();
  if (channelOwnedId) return channelOwnedId;
  const sessionOwnedId = sessionConversationId(context, agentId);
  if (sessionOwnedId) return sessionOwnedId;
  const candidates = [context.channelId, context.chatId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}

function canonicalConversationId(
  conversations: GitHubNotificationConversationState['conversations'],
  routedConversationId: string,
): string | undefined {
  if (Object.hasOwn(conversations, routedConversationId)) return routedConversationId;
  // OpenClaw can normalize flattened route ids, so recover only one canonical durable key.
  const normalized = routedConversationId.toLowerCase();
  const matches = Object.keys(conversations).filter(
    (candidate) => candidate.toLowerCase() === normalized,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Select one catalogued turn from trusted hook routing and private conversation state. */
export default class GitHubNotificationTurnSelector {
  readonly #dependencies: GitHubNotificationTurnSelectorDependencies;

  constructor(dependencies: GitHubNotificationTurnSelectorDependencies) {
    this.#dependencies = dependencies;
  }

  async select(
    context: AgentSystemHookContext,
  ): Promise<GitHubNotificationSelectedTurn | undefined> {
    const agentId = normalizedAgentId(context);
    if (!agentId) return undefined;
    const selectedConversationId = conversationId(context, agentId);
    if (!selectedConversationId) return undefined;

    try {
      const state = await this.#dependencies.conversations.read(agentId);
      if (!state) return undefined;
      const workspaceDir = context.workspaceDir?.trim();
      if (
        workspaceDir &&
        (!isAbsolute(workspaceDir) || resolve(workspaceDir) !== resolve(state.workspaceDir))
      ) {
        return undefined;
      }
      const selectedCanonicalConversationId = canonicalConversationId(
        state.conversations,
        selectedConversationId,
      );
      if (!selectedCanonicalConversationId) return undefined;
      const conversation = state.conversations[selectedCanonicalConversationId];
      if (!conversation?.activeTurn) return undefined;
      const identity = this.#dependencies.turns.resolve({
        eventId: conversation.activeTurn.eventId,
        lifecycleId: conversation.lifecycleId,
        modeId: conversation.mode,
      }).identity;
      return {
        agentId,
        conversationId: selectedCanonicalConversationId,
        identity,
        sourceId: conversation.activeTurn.sourceId,
      };
    } catch {
      this.#dependencies.logger.warn(
        'github-notifications: turn selection failed code=github-notification-turn-selection-failed',
      );
      return undefined;
    }
  }
}
