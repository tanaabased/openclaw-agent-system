import { feedbackRevision } from './feedback-source.ts';
import type { FeedbackProvider } from './feedback-provider.ts';
import {
  isReviewFeedback,
  reviewFeedback,
  reviewReplyFeedback,
  type GitHubCanonicalFeedback,
} from '../../../channels/github/provider/review-feedback.ts';

/** Retained provider metadata selects the exact source; prose never selects a destination. */
export function feedbackTarget(
  repository: string,
  event: {
    itemType: 'issue' | 'pull-request';
    number: number;
    source: string;
  },
) {
  const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
  const kind = isReviewFeedback(source)
    ? source.feedback.receipt.kind === 'review-comment'
      ? 'discussion_r'
      : 'pullrequestreview-'
    : 'issuecomment-';
  return `https://github.com/${repository}/${event.itemType === 'issue' ? 'issues' : 'pull'}/${event.number}#${kind}${source.databaseId}`;
}

/** the admitted source stays exact; only its retained review members may select another thread. */
export function feedbackReplyTarget(
  event: { source: string; revision: string; nodeId: string; number: number; itemType: string },
  target: ReplyTarget,
): boolean {
  if (
    target.nodeId !== event.nodeId ||
    target.number !== event.number ||
    target.itemType !== event.itemType ||
    !target.source
  )
    return false;
  const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
  if (target.source.nodeId === source.nodeId)
    return target.source.databaseId === source.databaseId && target.revision === event.revision;
  if (
    !isReviewFeedback(source) ||
    source.feedback.receipt.kind !== 'review' ||
    !isReviewFeedback(target.source) ||
    target.source.feedback.receipt.kind !== 'review-comment'
  )
    return false;
  const member = source.feedback.receipt.members[target.source.nodeId];
  const current = target.source.feedback.receipt.members[target.source.nodeId];
  return Boolean(
    member &&
    current &&
    target.source.feedback.comments[0]?.reviewId === source.feedback.receipt.reviewId &&
    member.databaseId === target.source.databaseId &&
    member.digest === current.digest &&
    target.source.feedback.receipt.reviewId === source.feedback.receipt.reviewId &&
    target.source.feedback.review.nodeId === source.feedback.review.nodeId,
  );
}

export function replyLocator(value: string) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9]\d*)(?:#(issuecomment-|discussion_r|pullrequestreview-)([1-9]\d*))?$/u.exec(
      value,
    );
  if (
    !match ||
    !Number.isSafeInteger(Number(match[4])) ||
    (match[6] && !Number.isSafeInteger(Number(match[6])))
  )
    throw new Error('reply-target-invalid');
  if (match[3] === 'issues' && match[5] && match[5] !== 'issuecomment-')
    throw new Error('reply-target-invalid');
  return {
    owner: match[1]!,
    name: match[2]!,
    number: Number(match[4]),
    itemType: match[3] === 'issues' ? ('issue' as const) : ('pull-request' as const),
    kind: match[5],
    commentId: match[6] ? Number(match[6]) : undefined,
  };
}

/** fixed provider readers verify the selected item and retain the original inline thread. */
export default async function readReplyTarget(provider: FeedbackProvider, url: string) {
  const locator = replyLocator(url);
  const { owner, name, number } = locator;
  const repository = await provider.getRepository(owner, name);
  const item = await provider.getItem(owner, name, number);
  if (
    item.number !== number ||
    item.itemType !== locator.itemType ||
    (item.itemType === 'pull-request' &&
      item.pullRequest.baseRepositoryNodeId !== repository.nodeId)
  )
    throw new Error('reply-target-diverged');
  let source: GitHubCanonicalFeedback | undefined;
  let root: number | undefined;
  if (locator.kind === 'issuecomment-')
    source = await provider.getIssueComment(owner, name, number, locator.commentId!);
  else if (locator.kind) {
    if (!provider.reviews) throw new Error('feedback-review-client-missing');
    if (locator.kind === 'pullrequestreview-') {
      const review = await provider.reviews.getReview(owner, name, number, locator.commentId!);
      source = reviewFeedback(
        review,
        await provider.reviews.getReviewComments(owner, name, number, review.databaseId),
      );
    } else {
      const comment = await provider.reviews.getComment(owner, name, number, locator.commentId!);
      root = comment.replyToId ?? comment.databaseId;
      const parent =
        root === comment.databaseId
          ? undefined
          : await provider.reviews.getComment(owner, name, number, root);
      if (
        parent &&
        (parent.reviewId !== comment.reviewId || (parent.replyToId && parent.replyToId !== root))
      )
        throw new Error('reply-thread-diverged');
      const review = await provider.reviews.getReview(owner, name, number, comment.reviewId);
      source = reviewReplyFeedback(review, comment, parent);
    }
  }
  if (
    source &&
    (source.databaseId !== locator.commentId ||
      source.bodyTruncated ||
      !source.nodeId ||
      !source.author ||
      ('feedback' in source &&
        (source.feedback.review.state === 'PENDING' ||
          !source.feedback.review.submittedAt ||
          source.feedback.review.bodyTruncated ||
          source.feedback.comments.some((c) => c.bodyTruncated || c.diffTruncated))))
  )
    throw new Error('reply-source-incomplete');
  const destination = `https://github.com/${repository.owner.login}/${repository.name}/${item.itemType === 'issue' ? 'issues' : 'pull'}/${number}${root ? `#discussion_r${root}` : ''}`;
  return {
    url,
    destination,
    owner: repository.owner.login,
    name: repository.name,
    number,
    itemType: item.itemType,
    nodeId: item.nodeId,
    repositoryNodeId: repository.nodeId,
    ...(source ? { source, revision: feedbackRevision(source) } : {}),
    ...(root ? { root } : {}),
  };
}
export type ReplyTarget = Awaited<ReturnType<typeof readReplyTarget>>;

/** Reconciliation reads the destination identity, not a possibly deleted source comment. */
export async function verifyReplyDestination(provider: FeedbackProvider, target: ReplyTarget) {
  const current = await readReplyTarget(provider, target.url.split('#')[0]!);
  if (current.repositoryNodeId !== target.repositoryNodeId || current.nodeId !== target.nodeId)
    throw new Error('reply-target-diverged');
  return target;
}
