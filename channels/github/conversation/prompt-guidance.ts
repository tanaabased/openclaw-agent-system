import type { PluginHookAgentContext } from 'openclaw/plugin-sdk/types';

import { githubNotificationChannelId } from '../routing/routing.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';
import type GitHubNotificationTurnSelector from './turn-selector.ts';

export interface GitHubNotificationPromptGuidanceDependencies {
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'instructions'>;
  turnSelector: Pick<GitHubNotificationTurnSelector, 'select'>;
}

/** Supply the currently shipped GitHub turn instructions through the prompt hook. */
export default async function githubNotificationPromptGuidance(
  context: PluginHookAgentContext,
  dependencies: GitHubNotificationPromptGuidanceDependencies,
): Promise<string | undefined> {
  if (context.messageProvider !== githubNotificationChannelId) return undefined;
  const identity = await dependencies.turnSelector.select(context);
  return identity === undefined ? undefined : dependencies.turnContracts.instructions(identity);
}
