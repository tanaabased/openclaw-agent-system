import { parseAgentSessionKey } from 'openclaw/plugin-sdk/routing';

import type { AgentSystemHookContext } from '../../../core/agent-hook-context.ts';
import type { Logger } from '../../../core/logger.ts';
import type GitHubNotificationReplyCandidateStore from '../publication/reply-candidate-store.ts';
import { githubNotificationChannelId } from '../routing/routing.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';
import type GitHubNotificationTurnSelector from './turn-selector.ts';

export interface GitHubNotificationPromptGuidanceDependencies {
  candidates: Pick<GitHubNotificationReplyCandidateStore, 'attestPromptSelection'>;
  logger: Pick<Logger, 'warn'>;
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'instructions'>;
  turnSelector: Pick<GitHubNotificationTurnSelector, 'select'>;
}

function isGitHubNotificationContext(context: AgentSystemHookContext): boolean {
  if (
    [context.channel, context.messageProvider].some(
      (candidate) => candidate?.trim().toLowerCase() === githubNotificationChannelId,
    )
  ) {
    return true;
  }
  const parsed = context.sessionKey ? parseAgentSessionKey(context.sessionKey) : null;
  return parsed?.rest.split(':')[0]?.toLowerCase() === githubNotificationChannelId;
}

/** Supply the currently shipped GitHub turn instructions through the prompt hook. */
export default async function githubNotificationPromptGuidance(
  context: AgentSystemHookContext,
  dependencies: GitHubNotificationPromptGuidanceDependencies,
): Promise<string | undefined> {
  if (!isGitHubNotificationContext(context)) return undefined;
  const selected = await dependencies.turnSelector.select(context);
  if (selected === undefined) {
    dependencies.logger.warn(
      'github-notifications: prompt guidance unavailable code=github-notification-prompt-turn-unresolved',
    );
    return undefined;
  }
  const instructions = dependencies.turnContracts.instructions(selected.identity, selected.agentId);
  await dependencies.candidates.attestPromptSelection(selected);
  return instructions;
}

/** Block before model execution if this turn never received its trusted prompt. */
export async function githubNotificationBeforeRun(
  context: AgentSystemHookContext,
  dependencies: {
    candidates: Pick<GitHubNotificationReplyCandidateStore, 'assertPromptSelected'>;
    turnSelector: Pick<GitHubNotificationTurnSelector, 'select'>;
    logger: Pick<Logger, 'warn'>;
  },
) {
  if (!isGitHubNotificationContext(context)) return undefined;
  try {
    const selected = await dependencies.turnSelector.select(context);
    if (!selected) throw new Error('unresolved turn');
    await dependencies.candidates.assertPromptSelected(selected);
    return undefined;
  } catch {
    const code = 'github-notification-model-turn-prompt-selection-missing';
    dependencies.logger.warn(`github-notifications: model execution blocked code=${code}`);
    return {
      outcome: 'block' as const,
      reason: code,
      message:
        'Required before_prompt_build did not attest this GitHub turn. Run openclaw agent-system doctor and the normal install flow; reload the Gateway before retrying.',
    };
  }
}
