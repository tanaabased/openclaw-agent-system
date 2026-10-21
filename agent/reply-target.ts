import { feedbackRevision } from './feedback-source.ts';
import type { OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import {
  reviewFeedback,
  reviewReplyFeedback,
  type GitHubCanonicalFeedback,
} from '../channels/github/provider/review-feedback.ts';

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
export default async function readReplyTarget(provider: OpenClawFeedbackProvider, url: string) {
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
