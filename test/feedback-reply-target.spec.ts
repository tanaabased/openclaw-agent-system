import assert from 'node:assert/strict';
import { feedbackReplyTarget, type ReplyTarget } from '../agent/tasks/feedback/reply-target.ts';
import { feedbackRevision } from '../agent/tasks/feedback/feedback-source.ts';
import {
  reviewFeedback,
  reviewReplyFeedback,
} from '../channels/github/provider/review-feedback.ts';
import { reviewFixture, reviewCommentFixture } from './github-review-fixtures.ts';

describe('agent/tasks/feedback/reply-target', () => {
  const review = reviewFixture();
  const comment = reviewCommentFixture();
  const source = reviewFeedback(review, [comment]);
  const event = {
    source: JSON.stringify(source),
    revision: feedbackRevision(source),
    nodeId: 'PR',
    number: 45,
    itemType: 'pull-request',
  };
  function target(overrides: Partial<ReplyTarget> = {}): ReplyTarget {
    const inline = reviewReplyFeedback(review, comment);
    return {
      url: comment.url,
      destination: comment.url,
      owner: 'owner',
      name: 'repo',
      number: 45,
      itemType: 'pull-request',
      nodeId: 'PR',
      repositoryNodeId: 'R',
      source: inline,
      revision: feedbackRevision(inline),
      root: comment.databaseId,
      ...overrides,
    };
  }
  it('should distinguish an exact source from its retained inline member without changing either', () => {
    assert.equal(feedbackReplyTarget(event, target()), true);
    assert.equal(feedbackReplyTarget(event, target({ source, revision: event.revision })), true);
    assert.equal(feedbackReplyTarget(event, target({ source, revision: 'changed' })), false);
    assert.equal(JSON.parse(event.source).nodeId, review.nodeId);
  });
  it('should reject other items, nonmembers, changed comments and cross-review metadata', () => {
    const variants = [
      target({ nodeId: 'other-pr' }),
      target({ number: 46 }),
      target({ itemType: 'issue' }),
      target({ source: reviewReplyFeedback(review, { ...comment, nodeId: 'nonmember' }) }),
      target({ source: reviewReplyFeedback(review, { ...comment, databaseId: 999 }) }),
      target({ source: reviewReplyFeedback(review, { ...comment, body: 'changed' }) }),
      target({ source: reviewReplyFeedback({ ...review, nodeId: 'other-review' }, comment) }),
      target({ source: reviewReplyFeedback({ ...review, databaseId: 99 }, comment) }),
      target({ source: reviewReplyFeedback(review, { ...comment, reviewId: 99 }) }),
    ];
    for (const value of variants) assert.equal(feedbackReplyTarget(event, value), false);
    const inline = reviewReplyFeedback(review, comment);
    assert.equal(
      feedbackReplyTarget(
        { ...event, source: JSON.stringify(inline), revision: feedbackRevision(inline) },
        target({ source: reviewReplyFeedback(review, { ...comment, nodeId: 'sibling' }) }),
      ),
      false,
    );
  });
});
