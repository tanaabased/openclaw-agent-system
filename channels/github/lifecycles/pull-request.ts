import githubNotificationItemContext from './context.ts';
import type { GitHubNotificationLifecycle } from './types.ts';

/** Own direct pull-request intake; later waves can add review-specific resources. */
export default class GitHubPullRequestLifecycle implements GitHubNotificationLifecycle {
  readonly commentTurns = { enabled: false as const };
  readonly context = {
    project(input: Parameters<GitHubNotificationLifecycle['context']['project']>[0]) {
      const pullRequest = input.item.pullRequest;
      if (input.item.itemType !== 'pull-request' || !pullRequest) {
        throw new Error('The pull-request lifecycle is missing trusted pull-request context.');
      }
      return {
        item: githubNotificationItemContext(input, 'pull-request'),
        pullRequest: {
          ...(pullRequest.authorNodeId === undefined
            ? {}
            : { authorNodeId: pullRequest.authorNodeId }),
          baseRef: pullRequest.baseRef,
          draft: pullRequest.draft,
          headRef: pullRequest.headRef,
          ...(pullRequest.headRepositoryDatabaseId === undefined
            ? {}
            : { headRepositoryDatabaseId: pullRequest.headRepositoryDatabaseId }),
          ...(pullRequest.headRepositoryNodeId === undefined
            ? {}
            : { headRepositoryNodeId: pullRequest.headRepositoryNodeId }),
          headSha: pullRequest.headSha,
        },
      };
    },
  };
  readonly eventSupport = { assignment: {} };
  readonly id = 'pull-request' as const;
  readonly instructions = 'Continue the current GitHub pull request lifecycle.';
  readonly modeSupport = {};
  readonly worktree = { required: false as const };
}
