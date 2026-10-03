import assert from 'node:assert/strict';

import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import {
  admitReviewFeedback,
  readReviewFeedback,
  reviewFeedback,
  reviewFeedbackContext,
  reviewFeedbackPresentation,
  reviewFeedbackRevision,
  reviewReplyFeedback,
} from '../channels/github/conversation/review-feedback.ts';
import { notificationAccount, notificationActor } from './github-notification-fixtures.ts';
import {
  reviewFixture,
  reviewCommentFixture,
  reviewClientFixture,
} from './github-review-fixtures.ts';

const configuration = {
  assignmentTypes: ['issue' as const],
  approvedActors: [notificationActor],
  intervalMinutes: 5,
  maxConcurrentIssues: 2,
};
const admit = (comment: ReturnType<typeof reviewFeedback>) =>
  admitReviewFeedback({ account: notificationAccount, configuration, comment });

describe('channels/github/conversation/review-feedback', () => {
  it('should admit a complete same-author review from a summary or finding mention', () => {
    const summary = reviewFixture();
    const finding = reviewCommentFixture();
    assert.equal(admit(reviewFeedback(summary, [finding])).disposition, 'approved');
    summary.body = '';
    finding.body = '@tanaabot handle empty arrays';
    assert.equal(admit(reviewFeedback(summary, [finding])).disposition, 'approved');
    for (const body of ['> @tanaabot do this', '`@tanaabot`', '```\n@tanaabot\n```']) {
      finding.body = body;
      assert.equal(admit(reviewFeedback(summary, [finding])).disposition, 'rejected');
    }
  });

  it('should group replies authored as part of the same submitted review', () => {
    const review = reviewFixture();
    const reply = reviewCommentFixture({ replyToId: 70 });
    const feedback = reviewFeedback(review, [reply]);
    assert.deepEqual(feedback.feedback.receipt.selected, [reply.nodeId]);
    assert.equal(admit(feedback).disposition, 'approved');
  });

  it('should reject pending, unauthorized, self, bot, mixed-author, and oversized feedback', () => {
    const finding = reviewCommentFixture();
    assert.equal(
      admit(reviewFeedback(reviewFixture({ state: 'PENDING', submittedAt: undefined }), [finding]))
        .code,
      'comment-review-pending',
    );
    for (const author of [
      { login: 'outsider', nodeId: 'U_other', type: 'User' },
      notificationAccount,
      { ...notificationActor, type: 'Bot' },
    ]) {
      assert.equal(admit(reviewFeedback(reviewFixture({ author }), [])).disposition, 'rejected');
    }
    assert.equal(
      admit(reviewFeedback(reviewFixture(), [{ ...finding, author: notificationAccount }]))
        .disposition,
      'rejected',
    );
    assert.equal(
      admit(reviewFeedback(reviewFixture(), [reviewCommentFixture({ body: 'a'.repeat(8_001) })]))
        .code,
      'comment-body-truncated',
    );
  });

  it('should keep later reply authority independent from its review and quoted parent', async () => {
    const review = reviewFixture();
    const parent = reviewCommentFixture({ body: '@tanaabot fix this' });
    const reply = reviewCommentFixture({
      databaseId: 83,
      nodeId: 'PRRC_reply',
      replyToId: 82,
      createdAt: '2026-09-01T12:01:00Z',
      updatedAt: '2026-09-01T12:01:00Z',
      body: 'Please continue',
    });
    assert.equal(admit(reviewReplyFeedback(review, reply, parent)).disposition, 'rejected');
    reply.body = '@tanaabot please continue';
    const feedback = reviewReplyFeedback(review, reply);
    assert.equal(admit(feedback).disposition, 'approved');
    const exact = await readReviewFeedback(
      reviewClientFixture(review, [parent, reply]),
      'tanaabased',
      'example',
      45,
      83,
      feedback.feedback.receipt,
    );
    const context = reviewFeedbackContext(exact);
    assert.ok('parent' in context);
    assert.equal(context.parent.contextOnly, true);
    assert.equal(reviewFeedbackContext(exact).findings[0]?.replyToId, 82);
  });

  it('should retain a reply when its referenced parent is unavailable', async () => {
    const review = reviewFixture();
    const reply = reviewCommentFixture({ replyToId: 70, body: '@tanaabot continue' });
    const feedback = reviewReplyFeedback(review, reply);
    const client = reviewClientFixture(review, [reply]);
    const getComment = client.getComment;
    client.getComment = async (owner, name, number, id) => {
      if (id === 70)
        throw new GitHubWorkEventClientError(
          'github-notification-resource-missing',
          'missing parent',
        );
      return getComment(owner, name, number, id);
    };
    const exact = await readReviewFeedback(
      client,
      'tanaabased',
      'example',
      45,
      reply.databaseId,
      feedback.feedback.receipt,
    );
    const context = reviewFeedbackContext(exact);
    assert.ok('parentUnavailable' in context);
    assert.equal(context.parentUnavailable, true);
    assert.equal(reviewFeedbackContext(exact).findings[0]?.replyToId, 70);
  });

  it('should select only edited findings and ignore coordinate changes for deduplication', () => {
    const review = reviewFixture();
    const finding = reviewCommentFixture();
    const other = reviewCommentFixture({ databaseId: 84, nodeId: 'PRRC_other' });
    const initial = reviewFeedback(review, [finding, other]);
    finding.line = 10;
    assert.deepEqual(
      reviewFeedbackRevision(reviewFeedback(review, [finding, other])),
      reviewFeedbackRevision(initial),
    );
    finding.body = 'Handle a missing object too';
    const changed = reviewFeedback(review, [finding, other], initial.feedback.receipt);
    assert.deepEqual(changed.feedback.receipt.selected, [finding.nodeId]);
    assert.equal(changed.feedback.receipt.summarySelected, false);
    assert.equal(reviewFeedbackContext(changed).findings.length, 1);
    review.body += ' and add coverage';
    assert.notDeepEqual(
      reviewFeedbackRevision(reviewFeedback(review, [finding, other])),
      reviewFeedbackRevision(changed),
    );
  });

  it('should preserve historical locations and diff provenance without fabricating current positions', () => {
    const context = reviewFeedbackContext(
      reviewFeedback(reviewFixture(), [reviewCommentFixture()]),
    );
    assert.equal(context.findings[0]?.line, null);
    assert.equal(context.findings[0]?.originalLine, 1);
    assert.equal(context.findings[0]?.originalCommitId, 'a'.repeat(40));
    assert.match(context.locationNotice, /historical/u);
  });

  it('should present grouped review prose with source links and honest compact locations', () => {
    const review = reviewFixture({ body: '## Summary\n\nKeep **Markdown** intact.' });
    const outdated = reviewCommentFixture({ body: 'Check `empty` values.\n\n- Keep the list.' });
    const current = reviewCommentFixture({
      body: 'Also handle missing input.',
      databaseId: 84,
      line: 10,
      nodeId: 'PRRC_other',
      url: 'https://github.com/tanaabased/example/pull/45#discussion_r84',
    });
    const card = reviewFeedbackPresentation(reviewFeedback(review, [outdated, current]));
    assert.match(card, /^## 💬 Review feedback\n/u);
    assert.ok(
      card.includes(
        '[the pull request](https://github.com/tanaabased/example/pull/45#pullrequestreview-81)',
      ),
    );
    assert.ok(card.includes('## Summary\n\nKeep **Markdown** intact.'));
    assert.ok(card.includes('Check `empty` values.\n\n- Keep the list.'));
    assert.ok(
      card.includes(
        `[Finding](${outdated.url}) · api/example.ts · original line 1 (historical; review line unavailable or outdated)`,
      ),
    );
    assert.ok(card.includes(`[Finding](${current.url}) · api/example.ts · review line 10`));
    assert.doesNotMatch(card, /current line|diffHunk|@@ -1|reviewed commit/u);
  });

  it('should link a later inline reply without presenting parent context as new feedback', () => {
    const parent = reviewCommentFixture({ body: 'Older parent finding.' });
    const reply = reviewCommentFixture({
      body: '@tanaabot Please continue.\n\n**New** detail.',
      databaseId: 83,
      nodeId: 'PRRC_reply',
      replyToId: 82,
    });
    const card = reviewFeedbackPresentation(reviewReplyFeedback(reviewFixture(), reply, parent));
    assert.match(card, /^## 💬 Review reply\n/u);
    assert.ok(card.includes(`[this discussion](${reply.url})`));
    assert.ok(card.includes(reply.body));
    assert.doesNotMatch(card, /Older parent finding|Review summary|diffHunk/u);
  });
});
