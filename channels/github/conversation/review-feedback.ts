import { createHash } from 'node:crypto';

import { GitHubWorkEventClientError } from '../provider/work-event-api-client.ts';
import {
  admitGitHubComment,
  type GitHubCanonicalIssueComment,
  type GitHubCommentAdmission,
  type GitHubCommentRevision,
} from './comment-admission.ts';
import type {
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
  GitHubPullRequestReviewClient,
} from '../provider/review-types.ts';

export interface GitHubReviewReceipt {
  kind: 'review' | 'review-comment';
  reviewId: number;
  summaryDigest: string;
  members: Record<string, { databaseId: number; digest: string }>;
  selected: string[];
  summarySelected: boolean;
}

export interface GitHubReviewFeedback extends GitHubCanonicalIssueComment {
  feedback: {
    review: GitHubPullRequestReview;
    comments: GitHubPullRequestReviewComment[];
    parent?: GitHubPullRequestReviewComment;
    receipt: GitHubReviewReceipt;
  };
}

export type GitHubCanonicalFeedback = GitHubCanonicalIssueComment | GitHubReviewFeedback;

export function isReviewFeedback(value: GitHubCanonicalFeedback): value is GitHubReviewFeedback {
  return 'feedback' in value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bodyDigest(comment: GitHubCanonicalIssueComment): string {
  return digest([
    comment.nodeId,
    comment.author?.nodeId,
    comment.author?.type,
    comment.body,
    comment.bodyTruncated,
  ]);
}

/** freeze the complete group identity separately from the changed findings sent to the model. */
export function reviewFeedback(
  review: GitHubPullRequestReview,
  comments: GitHubPullRequestReviewComment[],
  previous?: GitHubReviewReceipt,
): GitHubReviewFeedback {
  const findings = comments
    .filter(
      (comment) =>
        comment.replyToId === undefined ||
        previous?.members[comment.nodeId] !== undefined ||
        (!previous &&
          Date.parse(comment.createdAt) <= Date.parse(review.submittedAt ?? '') &&
          comment.author?.nodeId === review.author?.nodeId),
    )
    .sort((a, b) => a.databaseId - b.databaseId);
  const members = Object.fromEntries(
    findings.map((comment) => [
      comment.nodeId,
      { databaseId: comment.databaseId, digest: bodyDigest(comment) },
    ]),
  );
  const summaryDigest = bodyDigest(review);
  return {
    ...review,
    feedback: {
      review,
      comments: findings,
      receipt: {
        kind: 'review',
        reviewId: review.databaseId,
        summaryDigest,
        members,
        selected: findings
          .filter(
            (comment) =>
              previous?.members[comment.nodeId]?.digest !== members[comment.nodeId]!.digest,
          )
          .map((comment) => comment.nodeId),
        summarySelected: previous?.summaryDigest !== summaryDigest,
      },
    },
  };
}

export function reviewReplyFeedback(
  review: GitHubPullRequestReview,
  comment: GitHubPullRequestReviewComment,
  parent?: GitHubPullRequestReviewComment,
): GitHubReviewFeedback {
  return {
    ...comment,
    feedback: {
      review,
      comments: [comment],
      ...(parent ? { parent } : {}),
      receipt: {
        kind: 'review-comment',
        reviewId: review.databaseId,
        summaryDigest: bodyDigest(comment),
        members: {
          [comment.nodeId]: { databaseId: comment.databaseId, digest: bodyDigest(comment) },
        },
        selected: [comment.nodeId],
        summarySelected: true,
      },
    },
  };
}

export function reviewFeedbackRevision(comment: GitHubReviewFeedback): GitHubCommentRevision {
  const { receipt, review } = comment.feedback;
  const hash = digest([
    receipt.kind,
    review.nodeId,
    review.submittedAt,
    receipt.summaryDigest,
    receipt.members,
  ]);
  return { bodyDigest: hash, revisionId: hash };
}

/** only current approved author prose can address a group; context never supplies a mention. */
export function admitReviewFeedback(
  input: Omit<Parameters<typeof admitGitHubComment>[0], 'comment'> & {
    comment: GitHubReviewFeedback;
  },
): GitHubCommentAdmission {
  const { review, comments, receipt } = input.comment.feedback;
  if (review.state === 'PENDING' || !review.submittedAt)
    return { disposition: 'rejected', code: 'comment-review-pending' };
  const pieces = receipt.kind === 'review' ? [review, ...comments] : [input.comment];
  let approved: GitHubCommentAdmission | undefined;
  for (const piece of pieces) {
    if (receipt.kind === 'review' && piece.author?.nodeId !== review.author?.nodeId)
      return { disposition: 'rejected', code: 'comment-actor-unapproved' };
    const admission = admitGitHubComment({ ...input, comment: piece });
    if (admission.disposition === 'approved') approved = admission;
    else if (
      admission.code !== 'comment-mention-missing' &&
      admission.code !== 'comment-mention-quote-only'
    )
      return admission;
  }
  const length = pieces.reduce((total, piece) => total + [...piece.body].length, 0);
  if (
    comments.reduce((total, comment) => total + comment.diffHunk.length, 0) > 64_000 ||
    length > (input.maximumCommentCharacters ?? 8_000)
  )
    return { disposition: 'rejected', code: 'comment-body-truncated' };
  return approved ?? { disposition: 'rejected', code: 'comment-mention-missing' };
}

/** re-read and bind the exact resource; preserved selection makes interrupted turns reproducible. */
export async function readReviewFeedback(
  client: GitHubPullRequestReviewClient,
  owner: string,
  name: string,
  number: number,
  id: number,
  receipt: GitHubReviewReceipt,
): Promise<GitHubReviewFeedback> {
  const review = await client.getReview(owner, name, number, receipt.reviewId);
  if (receipt.kind === 'review') {
    if (review.databaseId !== id) throw new Error('Review source changed.');
    const result = reviewFeedback(
      review,
      await client.getReviewComments(owner, name, number, receipt.reviewId),
      receipt,
    );
    result.feedback.receipt.selected = receipt.selected;
    result.feedback.receipt.summarySelected = receipt.summarySelected;
    return result;
  }
  const comment = await client.getComment(owner, name, number, id);
  if (comment.reviewId !== receipt.reviewId || !comment.replyToId)
    throw new Error('Review reply source changed.');
  let parent: GitHubPullRequestReviewComment | undefined;
  try {
    parent = await client.getComment(owner, name, number, comment.replyToId);
  } catch (error) {
    if (
      !(error instanceof GitHubWorkEventClientError) ||
      error.code !== 'github-notification-resource-missing'
    )
      throw error;
  }
  return reviewReplyFeedback(review, comment, parent);
}

export function reviewFeedbackContext(comment: GitHubReviewFeedback) {
  const { review, comments, parent, receipt } = comment.feedback;
  return {
    kind: receipt.kind,
    review: {
      nodeId: review.nodeId,
      databaseId: review.databaseId,
      url: review.url,
      author: review.author,
      state: review.state,
      submittedAt: review.submittedAt,
      commitId: review.commitId,
      body: review.body,
      changed: receipt.summarySelected,
    },
    findings: comments.filter((value) => receipt.selected.includes(value.nodeId)),
    ...(parent
      ? { parent: { ...parent, contextOnly: true } }
      : receipt.kind === 'review-comment'
        ? { parentUnavailable: true }
        : {}),
    locationNotice:
      'Locations and diff hunks describe the reviewed commits. Null current positions are unavailable or outdated; original positions are historical, not current code. A different commit alone does not prove a finding is outdated.',
  };
}

export function reviewFeedbackPresentation(comment: GitHubReviewFeedback): string {
  const { review, receipt } = comment.feedback;
  const context = reviewFeedbackContext(comment);
  const lines = [
    `Review feedback from @${comment.author!.login}: ${receipt.kind === 'review' ? review.url : context.findings[0]!.url}`,
  ];
  if (receipt.kind === 'review')
    lines.push(
      `Review summary${receipt.summarySelected ? '' : ' (unchanged context)'}:\n${review.body || '(empty summary)'}`,
    );
  for (const finding of context.findings) {
    lines.push(
      `Finding ${finding.url}\nPath: ${JSON.stringify(finding.path)}; reviewed commit: ${finding.originalCommitId}; current line: ${finding.line ?? 'unavailable or outdated'}; original line: ${finding.originalLine ?? 'unavailable'}; side: ${finding.side ?? 'unavailable'}\n${finding.body}`,
    );
  }
  return lines.join('\n\n');
}
