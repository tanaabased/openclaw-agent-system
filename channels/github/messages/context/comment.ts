import type { GitHubCanonicalIssueComment } from '../../utils/comment-admission.ts';
import type {
  GitHubNotificationCommentRevisionState,
  GitHubNotificationItemState,
} from '../../utils/monitor-state.ts';
import { githubNotificationCommentUrl } from '../presentation/assignment-card.ts';

export interface GitHubNotificationCommentContextInput {
  comment: GitHubCanonicalIssueComment;
  item: Pick<
    GitHubNotificationItemState,
    'delivery' | 'itemType' | 'number' | 'repositoryName' | 'repositoryOwner'
  >;
  revision: Pick<
    GitHubNotificationCommentRevisionState,
    'bodyDigest' | 'commentDatabaseId' | 'commentNodeId' | 'revisionId'
  >;
}

/** Build bounded untrusted comment evidence without changing visible comment text. */
export default function githubNotificationCommentContext(
  input: GitHubNotificationCommentContextInput,
) {
  const author = input.comment.author;
  if (!author) throw new Error('GitHub notification comments must have an admitted author.');
  if (
    input.revision.commentDatabaseId !== input.comment.databaseId ||
    input.revision.commentNodeId !== input.comment.nodeId
  ) {
    throw new Error('GitHub notification comment revisions must match their admitted comment.');
  }
  const source = githubNotificationCommentUrl(input.item, input.comment.databaseId);
  return {
    label: `GitHub ${input.item.itemType} comment context`,
    payload: {
      bounds: {
        commentBodyCharacters: input.comment.body.length,
        commentBodyTruncated: input.comment.bodyTruncated,
      },
      comment: structuredClone({ ...input.comment, author }),
      item: {
        itemType: input.item.itemType,
        number: input.item.number,
        repositoryName: input.item.repositoryName,
        repositoryOwner: input.item.repositoryOwner,
      },
      revision: {
        bodyDigest: input.revision.bodyDigest,
        id: input.revision.revisionId,
      },
      statusEvidence: {
        assignmentActive: input.item.delivery?.stage === 'active',
        planningReplyStatus: input.item.delivery?.activation?.reply?.status ?? 'unknown',
        planningStatus: input.item.delivery?.activation?.status ?? 'unknown',
      },
    },
    source,
    type:
      input.item.itemType === 'pull-request'
        ? ('github_pull_request_comment' as const)
        : ('github_issue_comment' as const),
  };
}
