import type { GitHubNotificationItemState } from '../../intake/monitor/state.ts';

export interface GitHubNotificationAssignmentContextInput {
  item: GitHubNotificationItemState;
  worktree: { branch: string; path: string };
}

/** Project the untrusted context attached to an assignment receipt. */
export default function githubNotificationAssignmentContext(
  input: GitHubNotificationAssignmentContextInput,
) {
  return {
    item: {
      lifecycleId: input.item.lifecycleId,
      number: input.item.number,
      repositoryName: input.item.repositoryName,
      repositoryOwner: input.item.repositoryOwner,
    },
    worktree: input.worktree,
  };
}
