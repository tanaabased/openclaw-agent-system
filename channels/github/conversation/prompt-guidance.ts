import type { PluginHookAgentContext } from 'openclaw/plugin-sdk/types';

import { githubNotificationChannelId } from '../routing/routing.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';
import {
  decodeGitHubNotificationTurnIdentity,
  githubNotificationTurnContextKey,
} from './turn-identity.ts';

export interface GitHubNotificationPromptGuidanceDependencies {
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'instructions'>;
}

export class GitHubNotificationPromptGuidanceError extends Error {
  override name = 'GitHubNotificationPromptGuidanceError';

  constructor(readonly code: string) {
    super('The GitHub notification prompt guidance is unavailable.');
  }
}

/** Resolve hidden guidance only from channel-owned turn identity. */
export default function githubNotificationPromptGuidance(
  context: PluginHookAgentContext,
  dependencies: GitHubNotificationPromptGuidanceDependencies,
): string | undefined {
  if (context.messageProvider !== githubNotificationChannelId) return undefined;
  const identity = decodeGitHubNotificationTurnIdentity(
    context.channelContext?.chat?.[githubNotificationTurnContextKey],
  );
  if (!identity) {
    throw new GitHubNotificationPromptGuidanceError('github-notification-turn-identity-invalid');
  }
  return dependencies.turnContracts.instructions(identity);
}
