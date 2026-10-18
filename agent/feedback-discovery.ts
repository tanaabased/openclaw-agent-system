import { automationHash } from './automation-hash.ts';
import { type default as DiscoveryBudget, DiscoveryPaused } from './discovery-budget.ts';
import type { FeedbackSourceState } from './feedback-state.ts';
import type { GitHubNotificationCommentClient } from '../channels/github/provider/work-event-types.ts';
import type { GitHubPullRequestReviewComment } from '../channels/github/provider/review-types.ts';

/** retain completed provider observations, not a partially authoritative feedback baseline. */
export default async function feedbackDiscovery(input: {
  state: FeedbackSourceState;
  nodeId: string;
  now: number;
  client: GitHubNotificationCommentClient;
  budget: DiscoveryBudget;
  save(): Promise<void>;
}) {
  const { state, nodeId, now, client, budget, save } = input;
  state.startedAt ??= Object.keys(state.baseline).length ? 0 : now;
  state.discovery ??= {};
  const progress = (state.discovery[nodeId] ??= {
    since: state.watermarks?.[nodeId] ?? state.startedAt,
    startedAt: now,
    reads: {},
  });
  await save();
  const resumed = new Set(Object.keys(progress.reads));
  const verified = new Set<string>();
  async function read<T>(key: string, fetch: () => Promise<T>, page?: number): Promise<T> {
    budget.check();
    // re-read the continuation boundary before trusting a persisted page offset.
    if (page !== undefined && resumed.has(key)) {
      const family = key.slice(0, key.lastIndexOf(':') + 1);
      const last = Math.max(
        ...[...resumed]
          .filter((id) => id.startsWith(family))
          .map((id) => Number(id.slice(family.length)))
          .filter(Number.isFinite),
      );
      if (page === last && !verified.has(family)) {
        const fresh = await fetch();
        verified.add(family);
        if (automationHash(fresh) !== automationHash(JSON.parse(progress.reads[key]!))) {
          progress.reads = {};
          await save();
          throw new DiscoveryPaused();
        }
      }
    }
    if (progress.reads[key] !== undefined) return JSON.parse(progress.reads[key]!) as T;
    const value = await fetch();
    progress.reads[key] = JSON.stringify(value);
    await save();
    return value;
  }
  const since = new Date(Math.max(0, progress.since - 2000)).toISOString();
  const provider: {
    -readonly [K in keyof GitHubNotificationCommentClient]: GitHubNotificationCommentClient[K];
  } = {
    identity: client.identity,
    maximumCommentCharacters: client.maximumCommentCharacters,
    getIssueComment: (...args) => client.getIssueComment(...args),
    async listIssueComments(owner, name, number) {
      if (!client.listIssueCommentPage)
        return read('comments', async () => {
          const result = await client.listIssueComments(owner, name, number);
          if (result.truncated) throw new Error('feedback-source-incomplete');
          return result;
        });
      const comments = [];
      for (let page = 1; ; page++) {
        const result = await read(
          `comments:${page}`,
          () => client.listIssueCommentPage!(owner, name, number, page, since),
          page,
        );
        comments.push(...result.comments);
        if (comments.length > 1000) throw new Error('feedback-queue-full');
        if (!result.truncated) return { comments, truncated: false };
      }
    },
  };
  if (client.reviews) {
    const reviews = client.reviews;
    provider.reviews = {
      listReviews: (o, n, id, page) =>
        read(`reviews:${page}`, () => reviews.listReviews(o, n, id, page), page),
      listComments: (o, n, id, page) =>
        read(`review-comments:${page}`, () => reviews.listComments(o, n, id, page, since), page),
      getReview: (o, n, id, review) =>
        read(`review:${review}`, () => reviews.getReview(o, n, id, review)),
      getComment: (o, n, id, comment) =>
        read(`comment:${comment}`, () => reviews.getComment(o, n, id, comment)),
      async getReviewComments(o, n, id, review) {
        if (!reviews.getReviewCommentPage)
          return read(`members:${review}`, () => reviews.getReviewComments(o, n, id, review));
        const members = new Map<string, GitHubPullRequestReviewComment>();
        for (let page = 1; ; page++) {
          const result = await read(
            `members-${review}:${page}`,
            () => reviews.getReviewCommentPage!(o, n, id, review, page),
            page,
          );
          for (const value of result.values) members.set(value.nodeId, value);
          if (members.size > 400) throw new Error('feedback-queue-full');
          if (result.nextPage === 1) break;
        }
        const complete = [];
        for (const member of members.values()) {
          const fresh = await provider.reviews!.getComment(o, n, id, member.databaseId);
          if (fresh.reviewId !== review || fresh.nodeId !== member.nodeId)
            throw new Error('feedback-source-changed');
          complete.push(fresh);
        }
        return complete;
      },
    };
  }
  return {
    client: provider,
    async complete() {
      state.watermarks ??= {};
      state.watermarks[nodeId] = progress.startedAt;
      delete state.discovery![nodeId];
      await save();
    },
  };
}
