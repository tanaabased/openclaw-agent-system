import { feedbackAuthorityDigest } from './notification-authority.ts';
import feedbackDiscovery from './feedback-discovery.ts';
import type DiscoveryBudget from './discovery-budget.ts';
import { automationHash } from './automation-hash.ts';
import type { FeedbackSourceState, FeedbackSourceEvent } from './feedback-state.ts';
import { compactFeedback } from './feedback-retention.ts';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
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
  type GitHubReviewReceipt,
} from '../channels/github/provider/review-feedback.ts';
import type { GitHubNotificationCommentClient } from '../channels/github/provider/work-event-types.ts';
import type { GitHubIdentity } from '../channels/github/provider/work-item.ts';

export function feedbackRevision(source: GitHubCanonicalFeedback) {
  return isReviewFeedback(source)
    ? reviewFeedbackRevision(source).revisionId
    : githubCommentRevision(source).revisionId;
}

const fingerprint = Type.String({ pattern: '^[a-f0-9]{64}$' });
const baselineSchema = Type.Object(
  {
    retainedBaseline: Type.Literal(1),
    revision: fingerprint,
    receipt: Type.Optional(
      Type.Object(
        {
          kind: Type.Union([Type.Literal('review'), Type.Literal('review-comment')]),
          reviewId: Type.Integer({ minimum: 1 }),
          summaryDigest: fingerprint,
          members: Type.Record(
            Type.String(),
            Type.Object(
              { databaseId: Type.Integer({ minimum: 1 }), digest: fingerprint },
              { additionalProperties: false },
            ),
          ),
          selected: Type.Array(Type.String(), { uniqueItems: true }),
          summarySelected: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export function feedbackBaseline(value: string): {
  retainedBaseline: 1;
  revision: string;
  receipt?: GitHubReviewReceipt;
} {
  const parsed = JSON.parse(value);
  if (parsed?.retainedBaseline !== undefined) {
    if (
      !Value.Check(baselineSchema, parsed) ||
      parsed.receipt?.selected.some((id) => !parsed.receipt!.members[id])
    )
      throw new Error('feedback-baseline-invalid');
    return parsed;
  }
  const source = parsed as GitHubCanonicalFeedback;
  return {
    retainedBaseline: 1,
    revision: feedbackRevision(source),
    ...(isReviewFeedback(source) ? { receipt: source.feedback.receipt } : {}),
  };
}

export function compactFeedbackBaseline(state: FeedbackSourceState) {
  for (const baseline of Object.values(state.baseline))
    for (const [id, value] of Object.entries(baseline))
      baseline[id] = JSON.stringify(feedbackBaseline(value));
  for (const [id, marker] of Object.entries(state.reviewMarkers ?? {}))
    if (!/^[a-f0-9]{64}$/.test(marker))
      state.reviewMarkers![id] = automationHash(JSON.parse(marker));
}

export function admitFeedback(
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
export async function discoverFeedback(input: {
  state: FeedbackSourceState;
  client: GitHubNotificationCommentClient;
  policy: GitHubNotificationPolicy;
  owner: string;
  name: string;
  number: number;
  nodeId: string;
  itemType: 'issue' | 'pull-request';
  now: number;
  ownCommentIds?: readonly string[] | (() => Promise<readonly string[]>);
  discovery?: { budget: DiscoveryBudget; save(): Promise<void> };
}) {
  const { state, owner, name, number } = input;
  const discovery = input.discovery
    ? await feedbackDiscovery({ ...input, ...input.discovery })
    : undefined;
  const client = discovery?.client ?? input.client;
  const baseline = state.baseline[input.nodeId];
  const comments = await client.listIssueComments(owner, name, number);
  if (comments.truncated) throw new Error('feedback-source-incomplete');
  const sources: GitHubCanonicalFeedback[] = [...comments.comments];
  const changedReviewBodies = new Set<string>();
  const reviewMarkers = { ...state.reviewMarkers };
  if (input.itemType === 'pull-request') {
    if (!client.reviews) throw new Error('feedback-review-client-missing');
    const pages = async <T>(read: (page: number) => Promise<{ values: T[]; nextPage: number }>) => {
      const values: T[] = [];
      for (let page = 1; ; page++) {
        const result = await read(page);
        values.push(...result.values);
        if (values.length > 1000) throw new Error('feedback-queue-full');
        if (result.nextPage === 1) return values;
        if (result.nextPage !== page + 1) throw new Error('feedback-source-incomplete');
      }
    };
    const reviews = await pages((page) => client.reviews!.listReviews(owner, name, number, page));
    const reviewComments = await pages((page) =>
      client.reviews!.listComments(owner, name, number, page),
    );
    for (const review of reviews) {
      if (!review.submittedAt || review.state === 'PENDING') continue;
      const previous = baseline?.[review.nodeId];
      const group = previous ? feedbackBaseline(previous) : undefined;
      // reviews lack an edit timestamp: retain the small body marker, expanding members only for changes.
      if (discovery) {
        const marker = automationHash(review);
        const previousMarker = reviewMarkers[review.nodeId];
        const changed =
          previousMarker !== undefined &&
          (/^[a-f0-9]{64}$/.test(previousMarker)
            ? previousMarker
            : automationHash(JSON.parse(previousMarker))) !== marker;
        if (changed) changedReviewBodies.add(review.nodeId);
        const changedMember = reviewComments.some(
          (comment) =>
            comment.reviewId === review.databaseId &&
            Date.parse(comment.updatedAt) >
              (state.watermarks?.[input.nodeId] ?? state.startedAt ?? 0),
        );
        if (
          !changed &&
          !changedMember &&
          Date.parse(review.updatedAt) <= (state.watermarks?.[input.nodeId] ?? state.startedAt ?? 0)
        ) {
          reviewMarkers[review.nodeId] = marker;
          continue;
        }
        reviewMarkers[review.nodeId] = marker;
      }
      sources.push(
        reviewFeedback(
          review,
          await client.reviews.getReviewComments(owner, name, number, review.databaseId),
          group?.receipt,
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
  const ownCommentIds =
    typeof input.ownCommentIds === 'function' ? await input.ownCommentIds() : input.ownCommentIds;
  const revisions = new Map<string, string>();
  const next = { ...baseline };
  const pending: FeedbackSourceEvent[] = [];
  for (const source of sources) {
    const previous = baseline?.[source.nodeId];
    const revision = feedbackRevision(source);
    if (revisions.has(source.nodeId) && revisions.get(source.nodeId) !== revision)
      throw new Error('feedback-source-incomplete');
    revisions.set(source.nodeId, revision);
    next[source.nodeId] = JSON.stringify(feedbackBaseline(JSON.stringify(source)));
    if (
      ((!baseline || discovery) &&
        !previous &&
        !changedReviewBodies.has(source.nodeId) &&
        (state.startedAt === undefined ||
          Date.parse(source.updatedAt) <= state.startedAt ||
          !Number.isFinite(Date.parse(source.updatedAt)))) ||
      (previous && feedbackBaseline(previous).revision === revision)
    )
      continue;
    // provider receipts, not copied markers or account identity, identify our own replies.
    if (
      ownCommentIds?.includes(source.nodeId) ||
      state.events.some((event) => event.receipt?.nodeId === source.nodeId) ||
      state.history?.some((event) => event.receipt?.nodeId === source.nodeId)
    )
      continue;
    const id = automationHash([input.nodeId, source.nodeId, revision]);
    if (
      state.events.some((event) => event.id === id) ||
      state.history?.some((event) => event.id === id) ||
      pending.some((event) => event.id === id) ||
      admitFeedback(input.policy, client.identity, source).disposition !== 'approved'
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
      createdAt:
        !changedReviewBodies.has(source.nodeId) && Number.isFinite(Date.parse(source.updatedAt))
          ? Math.max(0, Math.min(input.now, Date.parse(source.updatedAt)))
          : input.now,
      policyDigest: feedbackAuthorityDigest(input.policy),
      phase: 'queued',
    });
  }
  compactFeedback(state);
  if (state.events.length + pending.length > 400 || Object.keys(next).length > 1000)
    throw new Error('feedback-queue-full');
  if (discovery) state.reviewMarkers = reviewMarkers;
  state.baseline[input.nodeId] = next;
  state.events.push(...pending);
  await discovery?.complete();
  return revisions;
}
