import {
  feedbackIdentities,
  workflowFeedbackAccepting,
} from '../channels/github/feedback-policy.ts';
import {
  admitGitHubComment,
  githubCommentRevision,
} from '../channels/github/provider/comment-admission.ts';
import {
  admitReviewFeedback,
  isReviewFeedback,
  reviewFeedback,
  reviewFeedbackRevision,
  reviewReplyFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';
import type { GitHubNotificationCommentClient } from '../channels/github/provider/work-event-types.ts';
import type { GitHubIdentity } from '../channels/github/provider/work-item.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import { automationHash } from './automation-hash.ts';
import { type default as DiscoveryBudget, DiscoveryPaused } from './discovery-budget.ts';
import feedbackDiscovery from './feedback-discovery.ts';
import type { FeedbackSourceEvent, FeedbackSourceState } from './feedback-state.ts';
import { feedbackAuthorityDigest } from './notification-authority.ts';

export function feedbackRevision(source: GitHubCanonicalFeedback) {
  return isReviewFeedback(source)
    ? reviewFeedbackRevision(source).revisionId
    : githubCommentRevision(source).revisionId;
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
    !workflowFeedbackAccepting(policy, 'issue-assignment') ||
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

/** persist observed enablement independently of provider pages and effect receipts. */
export function observeFeedbackPolicy(
  state: FeedbackSourceState,
  policy: GitHubNotificationPolicy | undefined,
  now: number,
) {
  const accepting = workflowFeedbackAccepting(policy, 'issue-assignment');
  if (accepting && state.admission?.enabled === false) {
    state.admission = {
      enabled: true,
      after: state.admission.observedAt,
      observedAt: now,
    };
    // fresh reads baseline the new window instead of resuming disabled-period pages.
    delete state.discovery;
  } else state.admission = { ...state.admission, enabled: accepting, observedAt: now };
  return accepting;
}

/** admit complete sources independently; advance the watermark only after all reads succeed. */
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
  const accepting = observeFeedbackPolicy(state, input.policy, input.now);
  const discovery = input.discovery
    ? await feedbackDiscovery({ ...input, ...input.discovery })
    : undefined;
  const client = discovery?.client ?? input.client;
  const retained = state.events.filter((event) => event.nodeId === input.nodeId);
  const baseline =
    state.baseline[input.nodeId] || retained.length
      ? {
          ...Object.fromEntries(retained.map((event) => [event.sourceId, event.source])),
          ...state.baseline[input.nodeId],
        }
      : undefined;
  let failure: { error: unknown; operation?: string } | undefined;
  async function collect<T>(read: () => Promise<T>) {
    try {
      return await read();
    } catch (error) {
      if (error instanceof Error && /discovery-checkpoint|private-state-file/.test(error.message))
        throw error;
      failure ??= { error, operation: input.discovery?.budget.operation };
    }
  }
  const sources: GitHubCanonicalFeedback[] = [];
  await collect(async () => {
    const comments = await client.listIssueComments(owner, name, number);
    if (comments.truncated) throw new Error('feedback-source-incomplete');
    sources.push(...comments.comments);
  });
  const policyDigest = feedbackAuthorityDigest(input.policy);
  for (const event of state.events) {
    const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
    if (
      accepting &&
      admitFeedback(input.policy, client.identity, source).disposition === 'approved'
    )
      delete event.policyHeld;
    else event.policyHeld = 'feedback-not-approved';
  }
  const changedReviewBodies = new Set<string>();
  const reviewMarkers = { ...state.reviewMarkers };
  if (input.itemType === 'pull-request')
    await collect(async () => {
      const reviewClient = client.reviews;
      if (!reviewClient) throw new Error('feedback-review-client-missing');
      const pages = async <T>(
        read: (page: number) => Promise<{ values: T[]; nextPage: number }>,
      ) => {
        const values: T[] = [];
        for (let page = 1; ; page++) {
          const result = await read(page);
          values.push(...result.values);
          if (result.nextPage === 1) return values;
          if (result.nextPage !== page + 1) throw new Error('feedback-source-incomplete');
        }
      };
      const reviews = await collect(() =>
        pages((page) => reviewClient.listReviews(owner, name, number, page)),
      );
      const reviewComments = await collect(() =>
        pages((page) => reviewClient.listComments(owner, name, number, page)),
      );
      for (const review of reviews ?? [])
        await collect(async () => {
          if (!review.submittedAt || review.state === 'PENDING') return;
          const previous = baseline?.[review.nodeId];
          const group = previous ? (JSON.parse(previous) as GitHubCanonicalFeedback) : undefined;
          // reviews lack an edit timestamp: retain the small body marker, expanding members only for changes.
          if (discovery) {
            const marker = JSON.stringify(review);
            const changed =
              reviewMarkers[review.nodeId] !== undefined && reviewMarkers[review.nodeId] !== marker;
            if (changed) changedReviewBodies.add(review.nodeId);
            const changedMember =
              reviewComments?.some(
                (comment) =>
                  comment.reviewId === review.databaseId &&
                  Date.parse(comment.updatedAt) >
                    (state.watermarks?.[input.nodeId] ?? state.startedAt ?? 0),
              ) ?? true;
            if (
              !changed &&
              !changedMember &&
              Date.parse(review.updatedAt) <=
                (state.watermarks?.[input.nodeId] ?? state.startedAt ?? 0)
            ) {
              reviewMarkers[review.nodeId] = marker;
              return;
            }
            reviewMarkers[review.nodeId] = marker;
          }
          sources.push(
            reviewFeedback(
              review,
              await reviewClient.getReviewComments(owner, name, number, review.databaseId),
              group && isReviewFeedback(group) ? group.feedback.receipt : undefined,
            ),
          );
        });
      for (const reply of (reviewComments ?? []).filter(
        (comment) => comment.replyToId !== undefined,
      ))
        await collect(async () => {
          const group = sources.find(
            (source) => isReviewFeedback(source) && source.feedback.receipt.members[reply.nodeId],
          );
          if (group) return;
          const review = await reviewClient.getReview(owner, name, number, reply.reviewId);
          const parent = reviewComments!.find((comment) => comment.databaseId === reply.replyToId);
          sources.push(reviewReplyFeedback(review, reply, parent));
        });
    });
  // Reconsider retained sources only after fresh comments, reviews and replies are collected.
  if (state.evaluatedPolicyDigests?.[input.nodeId] !== policyDigest)
    for (const encoded of Object.values(baseline ?? {})) {
      const saved = JSON.parse(encoded) as GitHubCanonicalFeedback;
      if (!sources.some((source) => source.nodeId === saved.nodeId)) sources.push(saved);
    }
  if (failure && sources.length === 0) {
    if (input.discovery && failure.operation) input.discovery.budget.operation = failure.operation;
    throw failure.error;
  }
  let ownCommentIds = typeof input.ownCommentIds === 'function' ? undefined : input.ownCommentIds;
  let observedOwn = typeof input.ownCommentIds !== 'function';
  let ownLookupFailed = false;
  const revisions = new Map<string, string>();
  const next = { ...baseline };
  const pending: FeedbackSourceEvent[] = [];
  for (const source of sources) {
    if (source.author?.nodeId === client.identity.nodeId) {
      if (!observedOwn) {
        observedOwn = true;
        try {
          ownCommentIds = await (input.ownCommentIds as () => Promise<readonly string[]>)();
        } catch {
          // an outgoing lookup cannot block unrelated incoming authors. retry this window later.
          ownLookupFailed = true;
        }
      }
      if (ownLookupFailed) continue;
    }
    const previous = baseline?.[source.nodeId];
    const revision = feedbackRevision(source);
    if (revisions.has(source.nodeId) && revisions.get(source.nodeId) !== revision)
      throw new Error('feedback-source-incomplete');
    revisions.set(source.nodeId, revision);
    const id = automationHash([input.nodeId, source.nodeId, revision]);
    next[source.nodeId] = JSON.stringify(source);
    if (
      ((!baseline || discovery) &&
        !previous &&
        !changedReviewBodies.has(source.nodeId) &&
        (state.startedAt === undefined ||
          Date.parse(source.updatedAt) <= state.startedAt ||
          !Number.isFinite(Date.parse(source.updatedAt)))) ||
      (previous &&
        feedbackRevision(JSON.parse(previous) as GitHubCanonicalFeedback) === revision &&
        (state.evaluatedPolicyDigests?.[input.nodeId] === policyDigest ||
          Date.parse(source.updatedAt) <= (state.startedAt ?? 0)))
    )
      continue;
    // provider receipts, not copied markers or account identity, identify our own replies.
    if (ownCommentIds?.includes(source.nodeId)) continue;
    if (!accepting) continue;
    const after = state.admission?.after;
    if (after !== undefined) {
      const updatedAt = Date.parse(source.updatedAt);
      const observedReviewEdit =
        changedReviewBodies.has(source.nodeId) && (state.watermarks?.[input.nodeId] ?? -1) >= after;
      if (!observedReviewEdit && (!Number.isFinite(updatedAt) || updatedAt <= after)) continue;
    }
    if (admitFeedback(input.policy, client.identity, source).disposition !== 'approved') continue;
    if (state.events.some((event) => event.id === id) || pending.some((event) => event.id === id))
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
      phase: 'queued',
    });
  }
  // Admitted sources already retain exact replay and reply evidence in their events.
  for (const event of [...retained, ...pending])
    if (next[event.sourceId] === event.source) delete next[event.sourceId];
  if (discovery && !ownLookupFailed && !failure) state.reviewMarkers = reviewMarkers;
  (state.evaluatedPolicyDigests ??= {})[input.nodeId] = policyDigest;
  state.baseline[input.nodeId] = next;
  state.events.push(...pending);
  if (failure?.error instanceof DiscoveryPaused || input.discovery?.budget.exhausted)
    await input.discovery?.save();
  else await discovery?.complete(!ownLookupFailed && !failure);
  if (failure) {
    if (input.discovery && failure.operation) input.discovery.budget.operation = failure.operation;
    throw failure.error;
  }
  return revisions;
}
