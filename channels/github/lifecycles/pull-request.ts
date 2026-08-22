import type { GitHubNotificationLifecycle } from './types.ts';

/** Own direct pull-request intake; later waves can add review-specific resources. */
export default class GitHubPullRequestLifecycle implements GitHubNotificationLifecycle {
  readonly id = 'pull-request' as const;
  readonly worktree = { required: false as const };
}
