import type { GitHubCanonicalIssueComment } from '../../utils/comment-admission.ts';

const maximumCommentBodyLength = 1_000;

/** Normalize one admitted comment for direct visible and model-facing input. */
export default function githubNotificationCommentInput(
  comment: Pick<GitHubCanonicalIssueComment, 'body' | 'bodyTruncated'>,
): string {
  if (comment.bodyTruncated) {
    throw new Error('GitHub notification comments must not be truncated.');
  }
  const body = comment.body.replace(/\r\n?/gu, '\n');
  if (!body.trim() || body.includes('\0') || body.length > maximumCommentBodyLength) {
    throw new Error('GitHub notification comment bodies are invalid.');
  }
  return body;
}
