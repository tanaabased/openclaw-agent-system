import type { PluginHookAgentContext } from 'openclaw/plugin-sdk/types';

import { githubNotificationChannelId } from '../routing/routing.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';

export interface GitHubNotificationPromptGuidanceDependencies {
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'instructions'>;
}

const currentTurnIdentity = {
  eventId: 'comment',
  lifecycleId: 'issue',
  modeId: 'work',
} as const;

/** Supply the currently shipped GitHub turn instructions through the prompt hook. */
export default function githubNotificationPromptGuidance(
  context: PluginHookAgentContext,
  dependencies: GitHubNotificationPromptGuidanceDependencies,
): string | undefined {
  if (context.messageProvider !== githubNotificationChannelId) return undefined;
  return dependencies.turnContracts.instructions(currentTurnIdentity);
}
