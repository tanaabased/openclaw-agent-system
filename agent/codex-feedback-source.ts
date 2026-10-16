import { automationHash } from './automation-hash.ts';
import type { CodexFeedback, FeedbackEvent } from './codex-feedback-state.ts';
import type { GitHubNotificationPolicy } from '../channels/github/config-schema.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import {
  admitGitHubComment,
  githubCommentRevision,
} from '../channels/github/provider/comment-admission.ts';
import {
  admitReviewFeedback,
  isReviewFeedback,
  reviewFeedbackRevision,
  reviewFeedback,
  reviewReplyFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import type { GitHubNotificationCommentClient } from '../channels/github/provider/work-event-types.ts';
import type { GitHubIdentity } from '../channels/github/provider/work-item.ts';

export function feedbackRevision(source: GitHubCanonicalFeedback) {
  return isReviewFeedback(source)
    ? reviewFeedbackRevision(source).revisionId
    : githubCommentRevision(source).revisionId;
}

export function admitCodexFeedback(
  policy: GitHubNotificationPolicy,
  account: GitHubIdentity,
  source: GitHubCanonicalFeedback,
) {
  const authors = feedbackIdentities(
    policy.issueAssignment?.allowed ?? [],
    policy.issueAssignment?.feedback,
  );
  const input = {
    account,
    allowSelf: true,
    configuration: {
      approvedFeedbackAuthors: authors,
      assignmentTypes: [],
      intervalMinutes: 5,
      maxConcurrentIssues: 3,
    },
  };
  if (
    !source.author ||
    !authors.some(
      (author) =>
        author.nodeId === source.author!.nodeId &&
        author.login.toLowerCase() === source.author!.login.toLowerCase(),
    )
  )
    return { disposition: 'rejected' as const, code: 'comment-actor-unapproved' };
  return isReviewFeedback(source)
    ? admitReviewFeedback({ ...input, comment: source })
    : admitGitHubComment({ ...input, comment: source });
}

/** commit a complete provider read atomically; incomplete pages never advance the baseline. */
export async function discoverCodexFeedback(input: {
  state: CodexFeedback;
  client: GitHubNotificationCommentClient;
  policy: GitHubNotificationPolicy;
  owner: string;
  name: string;
  number: number;
  nodeId: string;
  itemType: 'issue' | 'pull-request';
  now: number;
}) {
  const { state, client, owner, name, number } = input;
  const baseline = state.baseline[input.nodeId];
  const comments = await client.listIssueComments(owner, name, number);
  if (comments.truncated) throw new Error('feedback-source-incomplete');
  const sources: GitHubCanonicalFeedback[] = [...comments.comments];
  if (input.itemType === 'pull-request') {
    if (!client.reviews) throw new Error('feedback-review-client-missing');
    const pages = async <T>(read: (page: number) => Promise<{ values: T[]; nextPage: number }>) => {
      const values: T[] = [];
      for (let page = 1; page <= 10; page++) {
        const result = await read(page);
        values.push(...result.values);
        if (result.nextPage === 1) return values;
        if (result.nextPage !== page + 1) throw new Error('feedback-source-incomplete');
      }
      throw new Error('feedback-source-incomplete');
    };
    const reviews = await pages((page) => client.reviews!.listReviews(owner, name, number, page));
    const reviewComments = await pages((page) =>
      client.reviews!.listComments(owner, name, number, page),
    );
    for (const review of reviews) {
      if (!review.submittedAt || review.state === 'PENDING') continue;
      const previous = baseline?.[review.nodeId];
      const group = previous ? (JSON.parse(previous) as GitHubCanonicalFeedback) : undefined;
      sources.push(
        reviewFeedback(
          review,
          await client.reviews.getReviewComments(owner, name, number, review.databaseId),
          group && isReviewFeedback(group) ? group.feedback.receipt : undefined,
        ),
      );
    }
    for (const reply of reviewComments.filter((comment) => comment.replyToId !== undefined)) {
      const group = sources.find(
        (source) => isReviewFeedback(source) && source.feedback.receipt.members[reply.nodeId],
      );
      if (group) continue;
      const review = await client.reviews.getReview(owner, name, number, reply.reviewId);
      const parent = reviewComments.find((comment) => comment.databaseId === reply.replyToId);
      sources.push(reviewReplyFeedback(review, reply, parent));
    }
  }
  const revisions = new Map<string, string>();
  const next = { ...baseline };
  const pending: FeedbackEvent[] = [];
  for (const source of sources) {
    const previous = baseline?.[source.nodeId];
    const revision = feedbackRevision(source);
    if (revisions.has(source.nodeId) && revisions.get(source.nodeId) !== revision)
      throw new Error('feedback-source-incomplete');
    revisions.set(source.nodeId, revision);
    next[source.nodeId] = JSON.stringify(source);
    if (
      (!baseline &&
        (state.startedAt === undefined ||
          Date.parse(source.updatedAt) <= state.startedAt ||
          !Number.isFinite(Date.parse(source.updatedAt)))) ||
      (previous && feedbackRevision(JSON.parse(previous) as GitHubCanonicalFeedback) === revision)
    )
      continue;
    // provider receipts, not copied markers or account identity, identify our own replies.
    if (state.events.some((event) => event.receipt?.nodeId === source.nodeId)) continue;
    const id = automationHash([input.nodeId, source.nodeId, revision]);
    if (
      state.events.some((event) => event.id === id) ||
      pending.some((event) => event.id === id) ||
      admitCodexFeedback(input.policy, client.identity, source).disposition !== 'approved'
    )
      continue;
    pending.push({
      id,
      sourceId: source.nodeId,
      number,
      nodeId: input.nodeId,
      itemType: input.itemType,
      source: JSON.stringify(source),
      revision,
      createdAt: Number.isFinite(Date.parse(source.updatedAt))
        ? Math.max(0, Math.min(input.now, Date.parse(source.updatedAt)))
        : input.now,
      policyDigest: automationHash(input.policy),
      phase: 'queued',
    });
  }
  if (state.events.length + pending.length > 400 || Object.keys(next).length > 1000)
    throw new Error('feedback-queue-full');
  state.baseline[input.nodeId] = next;
  state.events.push(...pending);
}
