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
} from '../channels/github/provider/review-feedback.ts';
import { notificationAccount, notificationActor } from './github-provider-fixtures.ts';
import {
  reviewFixture,
  reviewCommentFixture,
  reviewClientFixture,
} from './github-review-fixtures.ts';

const configuration = {
  approvedFeedbackAuthors: [notificationActor],
};
const admit = (comment: ReturnType<typeof reviewFeedback>) =>
  admitReviewFeedback({ account: notificationAccount, configuration, comment });

describe('channels/github/provider/review-feedback', () => {
  it('should quote complete review and inline cards with exact source links and historical locations', () => {
    const review = reviewFixture({ body: 'Review summary.\n\n> Quoted context.' });
    const finding = reviewCommentFixture({
      body: 'First paragraph.\r\n\r\n- One\r\n- Two\r\n\r\n```ts\r\nrun();\r\n```',
      line: null,
      originalLine: 7,
    });
    for (const comment of [
      reviewFeedback(review, [finding]),
      reviewReplyFeedback(review, { ...finding, replyToId: 70 }),
    ]) {
      const card = reviewFeedbackPresentation(comment);
      assert.ok(!card.startsWith('> ## 💬'));
      assert.ok(card.indexOf('First paragraph.') < card.indexOf('reviewed commit'));
      assert.ok(card.split('\n').every((line) => line.startsWith('>')));
      assert.ok(card.includes('> - One\n> - Two'));
      assert.ok(card.includes('> ```ts\n> run();\n> ```'));
      assert.ok(card.includes('Current line: unavailable or outdated; original line: 7'));
      assert.ok(card.includes(finding.url));
      assert.ok(card.includes(finding.originalCommitId.slice(0, 7)));
      assert.ok(card.includes('> ```diff\n> @@ -1 +1 @@\n> +return values[0]\n> ```'));
      const source = comment.feedback.receipt.kind === 'review' ? review.url : finding.url;
      assert.ok(card.includes(`[Review comment ↗](${source}) from [@${comment.author!.login}]`));
    }
  });
  it('should preserve every finding permalink beside the exact review footer', () => {
    const review = reviewFixture();
    const first = reviewCommentFixture({
      nodeId: 'finding-one',
      databaseId: 81,
      url: 'https://github.com/owner/repo/pull/4#discussion_r81',
      body: 'First finding.',
    });
    const second = reviewCommentFixture({
      nodeId: 'finding-two',
      databaseId: 82,
      url: 'https://github.com/owner/repo/pull/4#discussion_r82',
      body: 'Second finding.',
    });
    const card = reviewFeedbackPresentation(reviewFeedback(review, [first, second]));
    for (const finding of [first, second]) {
      assert.ok(card.includes(finding.body));
      assert.ok(card.includes(`](${finding.url})`));
    }
    assert.ok(card.includes(`[Review comment ↗](${review.url})`));
  });

  it('should bound reviewed diff previews and preserve literal code fences', () => {
    const finding = reviewCommentFixture({
      diffHunk: [
        '@@ -1,30 +1,30 @@',
        ...Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`),
        '+```',
        '+' + 'x'.repeat(500),
      ].join('\r\n'),
    });
    const card = reviewFeedbackPresentation(reviewFeedback(reviewFixture(), [finding]));
    assert.ok(card.includes('Reviewed diff excerpt'));
    assert.ok(!card.includes('> +line 12\n'));
    assert.ok(card.includes('> +line 13\n'));
    assert.ok(card.includes('> ````diff\n'));
    assert.ok(card.includes('> +```\n'));
    assert.ok(!card.includes('x'.repeat(400)));
    assert.ok(card.includes('…'));
    assert.ok(card.includes('Preview shortened'));
    assert.ok(card.split('\n').every((line) => line.startsWith('>')));
    assert.ok(card.includes(finding.url));
  });
  it('should label provider-truncated and unavailable reviewed diffs honestly', () => {
    const render = (diffHunk: string, diffTruncated = false) =>
      reviewFeedbackPresentation(
        reviewFeedback(reviewFixture(), [reviewCommentFixture({ diffHunk, diffTruncated })]),
      );
    assert.ok(render('+partial', true).includes('Reviewed diff excerpt'));
    assert.ok(render('+trailing spaces  \n').includes('> +trailing spaces  \n'));
    assert.ok(render(' \n').includes('Reviewed diff unavailable'));
    assert.ok(!render(' \n').includes('```diff'));
  });
  it('should authorize submitted reviews and replies only through the feedback grant', () => {
    const review = reviewFixture();
    const finding = reviewCommentFixture();
    const feedbacks = [
      reviewFeedback(review, [finding]),
      reviewReplyFeedback(
        review,
        reviewCommentFixture({ replyToId: 70, body: '@tanaabot continue' }),
        finding,
      ),
    ];
    const assignmentOnly = {
      ...configuration,
      approvedFeedbackAuthors: [],
      approvedIssueAssigners: [notificationActor],
    };
    for (const comment of feedbacks) {
      assert.equal(
        admitReviewFeedback({
          account: notificationAccount,
          comment,
          configuration: {
            ...configuration,
            approvedFeedbackAuthors: [notificationActor],
          },
        }).disposition,
        'approved',
      );
      assert.equal(
        admitReviewFeedback({
          account: notificationAccount,
          comment,
          configuration: assignmentOnly,
        }).code,
        'comment-actor-unapproved',
      );
    }
  });

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

  it('should keep explicit thread replies separate even when submitted with their own review', () => {
    const review = reviewFixture();
    const reply = reviewCommentFixture({ replyToId: 70 });
    const feedback = reviewFeedback(review, [reply]);
    assert.deepEqual(feedback.feedback.receipt.selected, []);
    assert.equal(admit(feedback).disposition, 'approved');
  });

  it('should preserve previously grouped replies without changing their retained revision', () => {
    const review = reviewFixture();
    const reply = reviewCommentFixture();
    const previous = reviewFeedback(review, [reply]);
    reply.replyToId = 70;
    const retained = reviewFeedback(review, [reply], previous.feedback.receipt);
    assert.deepEqual(retained.feedback.receipt.selected, []);
    assert.deepEqual(Object.keys(retained.feedback.receipt.members), [reply.nodeId]);
    assert.deepEqual(reviewFeedbackRevision(retained), reviewFeedbackRevision(previous));
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
});
