import type { GitHubCanonicalIssueComment, GitHubCommentRevision } from '../comment-admission.ts';
import type { GitHubNotificationItemState } from '../../intake/monitor/state.ts';

export interface GitHubNotificationCommentContextInput {
  comment: GitHubCanonicalIssueComment;
  item: GitHubNotificationItemState;
  revision: GitHubCommentRevision;
  worktree: { branch: string; path: string };
}

/** Project the untrusted context attached to an admitted comment turn. */
export default function githubNotificationCommentContext(
  input: GitHubNotificationCommentContextInput,
) {
  return {
    comment: {
      databaseId: input.comment.databaseId,
      nodeId: input.comment.nodeId,
      revisionId: input.revision.revisionId,
    },
    item: {
      lifecycleId: input.item.lifecycleId,
      number: input.item.number,
      repositoryName: input.item.repositoryName,
      repositoryOwner: input.item.repositoryOwner,
    },
    worktree: input.worktree,
  };
}
