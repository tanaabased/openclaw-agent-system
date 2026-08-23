import { isAbsolute, resolve } from 'node:path';

import type { PluginHookAgentContext } from 'openclaw/plugin-sdk/types';

import type { Logger } from '../../../core/logger.ts';
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

function normalizedAgentId(context: PluginHookAgentContext): string | undefined {
  const agentId = context.agentId?.trim().toLowerCase();
  return agentId && /^[a-z0-9][a-z0-9-]*$/u.test(agentId) ? agentId : undefined;
}

function conversationId(context: PluginHookAgentContext): string | undefined {
  const candidates = [context.channelId, context.chatId, context.channelContext?.chat?.id]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}

/** Select one catalogued turn from trusted hook routing and private conversation state. */
export default class GitHubNotificationTurnSelector {
  readonly #dependencies: GitHubNotificationTurnSelectorDependencies;

  constructor(dependencies: GitHubNotificationTurnSelectorDependencies) {
    this.#dependencies = dependencies;
  }

  async select(
    context: PluginHookAgentContext,
  ): Promise<GitHubNotificationTurnIdentity | undefined> {
    const agentId = normalizedAgentId(context);
    const selectedConversationId = conversationId(context);
    if (!agentId || !selectedConversationId) return undefined;

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
      const conversation = state.conversations[selectedConversationId];
      if (!conversation?.activeTurn) return undefined;
      return this.#dependencies.turns.resolve({
        eventId: conversation.activeTurn.eventId,
        lifecycleId: conversation.lifecycleId,
        modeId: conversation.mode,
      }).identity;
    } catch {
      this.#dependencies.logger.warn(
        'github-notifications: turn selection failed code=github-notification-turn-selection-failed',
      );
      return undefined;
    }
  }
}
