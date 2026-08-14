import { githubCommentRevision, type GitHubCanonicalIssueComment } from './comment-admission.ts';
import {
  githubNotificationActorLink,
  githubNotificationCommentLink,
  githubNotificationCommentUrl,
} from './assignment-presentation.ts';
import type {
  GitHubNotificationCommentRevisionState,
  GitHubNotificationItemState,
} from './monitor-state.ts';
import githubNotificationTurnBody, {
  githubNotificationCommentResponseInstructions,
  githubNotificationMarkdownQuote,
  type GitHubNotificationTurnPresentation,
} from './turn-presentation.ts';

export interface GitHubNotificationCommentPromptInput {
  comment: GitHubCanonicalIssueComment;
  item: Pick<
    GitHubNotificationItemState,
    'delivery' | 'itemType' | 'number' | 'repositoryName' | 'repositoryOwner'
  >;
  revision: GitHubNotificationCommentRevisionState;
}

export interface GitHubNotificationCommentContextPayload {
  comment: GitHubCanonicalIssueComment;
  provenance: {
    bodyDigest: string;
    commentDatabaseId: number;
    commentNodeId: string;
    revisionId: string;
  };
  statusEvidence: {
    acknowledgmentStatus: string;
    assignmentActive: boolean;
    planningStatus: string;
  };
}

export type GitHubNotificationCommentPrompt =
  GitHubNotificationTurnPresentation<GitHubNotificationCommentContextPayload>;

/** Separate one readable comment request from its current-turn-only provider evidence. */
export default function githubNotificationCommentPrompt(
  input: GitHubNotificationCommentPromptInput,
): GitHubNotificationCommentPrompt {
  const author = input.comment.author;
  if (!author) throw new Error('GitHub notification comment authors must be available.');
  const revision = githubCommentRevision(input.comment);
  if (
    input.comment.databaseId !== input.revision.commentDatabaseId ||
    input.comment.nodeId !== input.revision.commentNodeId ||
    author.nodeId !== input.revision.actorNodeId ||
    revision.bodyDigest !== input.revision.bodyDigest ||
    revision.revisionId !== input.revision.revisionId
  ) {
    throw new Error('GitHub notification comment provenance must match the current revision.');
  }
  const statusEvidence = {
    acknowledgmentStatus: input.item.delivery?.acknowledgment?.status ?? 'unknown',
    assignmentActive: input.item.delivery?.stage === 'active',
    planningStatus: input.item.delivery?.activation?.status ?? 'unknown',
  };
  const source = githubNotificationCommentUrl(input.item, input.comment.databaseId);
  return {
    body: githubNotificationTurnBody({
      action: 'Please respond conversationally in this private issue session.',
      content: githubNotificationMarkdownQuote(input.comment.body),
      heading: '## 💬 Comment received',
      introduction: `${githubNotificationActorLink(author.login)} commented on ${githubNotificationCommentLink(input.item, input.comment.databaseId)}:`,
      mode: 'Comment response — do not use tools or begin implementation.',
    }),
    instructions: githubNotificationCommentResponseInstructions,
    untrustedContext: {
      label: `GitHub ${input.item.itemType} comment context`,
      payload: structuredClone({
        comment: input.comment,
        provenance: {
          bodyDigest: input.revision.bodyDigest,
          commentDatabaseId: input.revision.commentDatabaseId,
          commentNodeId: input.revision.commentNodeId,
          revisionId: input.revision.revisionId,
        },
        statusEvidence,
      }),
      source,
      type: 'github_issue_comment',
    },
  };
}
