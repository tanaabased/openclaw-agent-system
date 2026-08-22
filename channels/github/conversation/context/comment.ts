import type { GitHubCanonicalIssueComment, GitHubCommentRevision } from '../comment-admission.ts';

export interface GitHubNotificationCommentContextInput {
  comment: GitHubCanonicalIssueComment;
  lifecycleContext: Readonly<Record<string, unknown>>;
  revision: GitHubCommentRevision;
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
    ...input.lifecycleContext,
  };
}
