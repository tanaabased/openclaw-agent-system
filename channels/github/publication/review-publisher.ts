import { Value } from 'typebox/value';

import { automationHash } from '../../../agent/automation-hash.ts';
import type GitHubWorkEventClient from '../provider/work-event-client.ts';
import { reviewDraftSchema, reviewEventState, type ReviewDraft } from '../provider/review-draft.ts';
import type { GitHubPullRequestReview } from '../provider/review-types.ts';
import GitHubNotificationCommentPublisher, {
  type GitHubNotificationCommentPublisherDependencies,
} from './comment-publisher.ts';
import {
  githubNotificationPublicationText,
  type GitHubNotificationPublicationItem,
} from './publication-contract.ts';

/** formal reviews share authorization, sanitization, serialization and uncertain-write reconciliation. */
export default function reviewPublisher(
  input: {
    item: GitHubNotificationPublicationItem;
    head: string;
    draft: ReviewDraft;
    publicationId: string;
  },
  dependencies: Omit<GitHubNotificationCommentPublisherDependencies, 'connect'> & {
    connect(): Promise<
      Pick<GitHubWorkEventClient, 'identity' | 'getItem' | 'getReviewCI'> & {
        reviews: Pick<
          GitHubWorkEventClient['reviews'],
          'getReviewComments' | 'listReviews' | 'submit'
        >;
      }
    >;
  },
) {
  if (!Value.Check(reviewDraftSchema, input.draft)) throw new Error('review-draft-invalid');
  const draft = structuredClone(input.draft);
  for (const comment of draft.comments) {
    comment.body = githubNotificationPublicationText(
      'formal-review',
      [{ text: comment.body }],
      dependencies.redactText,
    );
    if (
      (comment.startLine === undefined) !== (comment.startSide === undefined) ||
      (comment.startLine !== undefined &&
        comment.startSide === comment.side &&
        comment.startLine > comment.line)
    )
      throw new Error('review-draft-range-invalid');
  }
  const { repositoryOwner: owner, repositoryName: name, number } = input.item;
  let connected: Awaited<ReturnType<typeof dependencies.connect>> | undefined;
  const publisher = new GitHubNotificationCommentPublisher({
    ...dependencies,
    beforeCreate: async () => {
      const client = connected!;
      const item = await client.getItem(owner, name, number);
      if (
        item.itemType !== 'pull-request' ||
        item.state !== 'open' ||
        item.pullRequest.merged ||
        item.pullRequest.draft ||
        item.pullRequest.headSha !== input.head
      )
        throw new Error('review-publication-revision-changed');
      if (item.pullRequest.author?.nodeId === client.identity.nodeId)
        throw new Error('review-self-review-disallowed');
      const ci = await client.getReviewCI(owner, name, number, input.head);
      if (
        ci.state === 'running' ||
        (draft.event === 'APPROVE' && ci.state !== 'absent' && !ci.passing)
      )
        throw new Error('review-publication-ci-not-ready');
      await dependencies.beforeCreate?.();
    },
    connect: async () => {
      const client = (connected = await dependencies.connect());
      const verify = async (review: GitHubPullRequestReview) => {
        if (
          review.author?.nodeId !== client.identity.nodeId ||
          review.commitId !== input.head ||
          review.state !== reviewEventState[draft.event] ||
          review.bodyTruncated
        )
          throw new Error('review-reconciliation-conflict');
        const comments = await client.reviews.getReviewComments(
          owner,
          name,
          number,
          review.databaseId,
        );
        const expected = draft.comments
          .map((comment) =>
            automationHash({
              ...comment,
              startLine: comment.startLine ?? null,
              startSide: comment.startSide ?? null,
            }),
          )
          .sort();
        const actual = comments
          .map((comment) => {
            if (
              comment.bodyTruncated ||
              comment.author?.nodeId !== client.identity.nodeId ||
              comment.originalCommitId !== input.head
            )
              throw new Error('review-reconciliation-conflict');
            return automationHash({
              path: comment.path,
              body: comment.body,
              line: comment.originalLine,
              side: comment.side,
              startLine: comment.originalStartLine,
              startSide: comment.startSide,
            });
          })
          .sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual))
          throw new Error('review-reconciliation-conflict');
        return review;
      };
      return {
        client: {
          findOwnIssueComment: async (_owner, _name, _number, marker) => {
            let found: GitHubPullRequestReview | undefined;
            for (let page = 1; ;) {
              const result = await client.reviews.listReviews(owner, name, number, page);
              for (const review of result.values) {
                if (
                  review.author?.nodeId !== client.identity.nodeId ||
                  !review.body.includes(marker)
                )
                  continue;
                if (found) throw new Error('review-reconciliation-ambiguous');
                found = await verify(review);
              }
              if (result.nextPage === 1) break;
              page = result.nextPage;
            }
            return found;
          },
          createIssueComment: async (_owner, _name, _number, body) => {
            return verify(
              await client.reviews.submit(owner, name, number, input.head, { ...draft, body }),
            );
          },
        },
      };
    },
  });
  const publication = {
    item: input.item,
    intent: 'formal-review' as const,
    text: draft.body,
    publicationId: input.publicationId,
  };
  return {
    publish: () => publisher.publish(publication),
    reconcile: () => publisher.reconcile(publication),
  };
}
