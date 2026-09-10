import assert from 'node:assert/strict';

import type {
  GitHubNotificationConversationSnapshot,
  GitHubNotificationConversationState,
} from '../channels/github/conversation/conversation-state.ts';

export function conversationSnapshot(
  state: GitHubNotificationConversationState | undefined,
  conversationId: string,
): GitHubNotificationConversationSnapshot | undefined {
  if (!state) return undefined;
  return structuredClone({
    agentId: state.agentId,
    conversationId,
    workspaceDir: state.workspaceDir,
    ...(state.conversations[conversationId]
      ? { conversation: state.conversations[conversationId] }
      : {}),
  });
}

export function replaceConversationSnapshot(
  state: GitHubNotificationConversationState | undefined,
  next: GitHubNotificationConversationSnapshot,
): GitHubNotificationConversationState {
  assert.ok(next.conversation);
  return structuredClone({
    agentId: next.agentId,
    conversations: { ...state?.conversations, [next.conversationId]: next.conversation },
    schemaVersion: 7,
    workspaceDir: next.workspaceDir,
  });
}
