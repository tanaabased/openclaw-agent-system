import {
  isReviewFeedback,
  reviewFeedbackContext,
  type GitHubCanonicalFeedback,
} from '../review-feedback.ts';
import type { GitHubCommentRevision } from '../comment-admission.ts';
import type { GitHubNotificationConversationSource } from '../conversation-state.ts';

export interface GitHubNotificationCommentContextInput {
  comment: GitHubCanonicalFeedback;
  lifecycleContext: Readonly<Record<string, unknown>>;
  revision: GitHubCommentRevision;
  source: GitHubNotificationConversationSource;
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
    ...(isReviewFeedback(input.comment) ? { feedback: reviewFeedbackContext(input.comment) } : {}),
    source: input.source,
    ...input.lifecycleContext,
  };
}
