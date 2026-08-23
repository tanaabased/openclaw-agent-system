import type { GitHubCanonicalIssueComment, GitHubCommentRevision } from '../comment-admission.ts';
import type { GitHubNotificationItemContext } from '../../provider/work-event-client.ts';

export interface GitHubNotificationCommentContextInput {
  comment: GitHubCanonicalIssueComment;
  itemContext?: GitHubNotificationItemContext;
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
    ...(input.itemContext === undefined ? {} : { currentItem: input.itemContext }),
    ...input.lifecycleContext,
  };
}
