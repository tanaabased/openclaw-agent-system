import type { AgentSystemHookContext } from '../../../core/agent-hook-context.ts';
import type GitHubNotificationReplyCandidateStore from '../publication/reply-candidate-store.ts';
import { githubNotificationChannelId } from '../routing/routing.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';
import type GitHubNotificationTurnSelector from './turn-selector.ts';

export interface GitHubNotificationPromptGuidanceDependencies {
  candidates: Pick<GitHubNotificationReplyCandidateStore, 'attestPromptSelection'>;
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'instructions'>;
  turnSelector: Pick<GitHubNotificationTurnSelector, 'select'>;
}

/** Supply the currently shipped GitHub turn instructions through the prompt hook. */
export default async function githubNotificationPromptGuidance(
  context: AgentSystemHookContext,
  dependencies: GitHubNotificationPromptGuidanceDependencies,
): Promise<string | undefined> {
  if (context.messageProvider !== githubNotificationChannelId) return undefined;
  const selected = await dependencies.turnSelector.select(context);
  if (selected === undefined) return undefined;
  const instructions = dependencies.turnContracts.instructions(selected.identity);
  await dependencies.candidates.attestPromptSelection(selected);
  return instructions;
}
