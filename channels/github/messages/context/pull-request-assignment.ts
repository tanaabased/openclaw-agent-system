import type { GitHubNotificationPlanningContext } from '../../lib/work-event-client.ts';
import type { GitHubNotificationPullRequestState } from '../../utils/monitor-state.ts';
import { githubNotificationItemUrl } from '../presentation/assignment-card.ts';

export interface GitHubNotificationPullRequestContextInput {
  context: GitHubNotificationPlanningContext;
  item: Parameters<typeof githubNotificationItemUrl>[0] & {
    itemType: 'pull-request';
    pullRequest: Pick<
      GitHubNotificationPullRequestState,
      'baseRef' | 'draft' | 'headRef' | 'headSha'
    >;
  };
}

/** Build bounded untrusted pull-request evidence for one planning turn. */
export default function githubNotificationPullRequestContext(
  input: GitHubNotificationPullRequestContextInput,
) {
  return {
    label: 'GitHub pull-request context',
    payload: structuredClone({
      ...input.context,
      pullRequest: {
        baseRef: input.item.pullRequest.baseRef,
        draft: input.item.pullRequest.draft,
        headRef: input.item.pullRequest.headRef,
        headSha: input.item.pullRequest.headSha,
      },
    }),
    source: githubNotificationItemUrl(input.item),
    type: 'github_pull_request' as const,
  };
}
