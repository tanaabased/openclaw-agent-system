import type { GitHubNotificationPlanningContext } from '../lib/work-event-client.ts';
import resolveGitHubNotificationMessage from '../lib/message-registry.ts';
import githubNotificationIssueContext from '../messages/context/issue-assignment.ts';
import githubNotificationPullRequestContext from '../messages/context/pull-request-assignment.ts';
import githubNotificationAssignmentCard from '../messages/presentation/assignment-card.ts';
import type {
  GitHubNotificationItemState,
  GitHubNotificationPullRequestState,
} from './monitor-state.ts';

export interface GitHubNotificationPlanningPromptInput {
  context: GitHubNotificationPlanningContext;
  item: Pick<
    GitHubNotificationItemState,
    | 'assignmentActorLogin'
    | 'itemType'
    | 'number'
    | 'pullRequest'
    | 'repositoryName'
    | 'repositoryOwner'
  >;
}

export interface GitHubNotificationPlanningPromptContext extends GitHubNotificationPlanningContext {
  pullRequest?: Pick<
    GitHubNotificationPullRequestState,
    'baseRef' | 'draft' | 'headRef' | 'headSha'
  >;
}

/** Compose compatibility planning layers without placing instructions in presentation. */
export default function githubNotificationPlanningPrompt(
  input: GitHubNotificationPlanningPromptInput,
) {
  const request = {
    assignmentKind: input.item.itemType,
    event: 'planning-request' as const,
    mode: 'plan' as const,
  };
  const definition = resolveGitHubNotificationMessage(request);
  const untrustedContext =
    input.item.itemType === 'issue'
      ? githubNotificationIssueContext({
          context: input.context,
          item: { ...input.item, itemType: 'issue' },
        })
      : githubNotificationPullRequestContext({
          context: input.context,
          item: {
            ...input.item,
            itemType: 'pull-request',
            pullRequest: input.item.pullRequest!,
          },
        });
  return {
    body: githubNotificationAssignmentCard({
      item: input.item,
      mode: 'plan',
      title: input.context.title,
    }),
    instructions: definition.instructions!,
    request,
    untrustedContext,
  };
}
