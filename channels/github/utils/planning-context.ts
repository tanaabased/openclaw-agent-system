import type { GitHubNotificationPlanningContext } from '../lib/work-event-client.ts';
import {
  githubNotificationAssignmentSentence,
  githubNotificationItemUrl,
} from './assignment-presentation.ts';
import type { GitHubNotificationItemState } from './monitor-state.ts';
import githubNotificationTurnBody, {
  githubNotificationPlanningInstructions,
  type GitHubNotificationTurnPresentation,
} from './turn-presentation.ts';

export interface GitHubNotificationPlanningPromptInput {
  context: GitHubNotificationPlanningContext;
  item: Pick<
    GitHubNotificationItemState,
    'itemType' | 'number' | 'repositoryName' | 'repositoryOwner'
  >;
}

export type GitHubNotificationPlanningPrompt =
  GitHubNotificationTurnPresentation<GitHubNotificationPlanningContext>;

/** Separate one readable planning request from its current-turn-only untrusted issue data. */
export default function githubNotificationPlanningPrompt(
  input: GitHubNotificationPlanningPromptInput,
): GitHubNotificationPlanningPrompt {
  return {
    body: githubNotificationTurnBody({
      action: 'Please review it and prepare a private implementation plan.',
      heading: '## 📋 Planning request',
      introduction: githubNotificationAssignmentSentence(input.item, input.context.title),
      mode: 'Plan — do not use tools or begin implementation.',
    }),
    instructions: githubNotificationPlanningInstructions,
    untrustedContext: {
      label: `GitHub ${input.item.itemType} context`,
      payload: structuredClone(input.context),
      source: githubNotificationItemUrl(input.item),
      type: input.item.itemType === 'pull-request' ? 'github_pull_request' : 'github_issue',
    },
  };
}
