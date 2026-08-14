import assert from 'node:assert/strict';

import githubNotificationCommentReply, {
  assertGitHubNotificationCommentResponse,
  GitHubNotificationCommentResponseError,
} from '../channels/github/utils/comment-response.ts';
import { GitHubNotificationPublicationError } from '../channels/github/utils/publication.ts';

function commentResponse(reply: string, response = 'The assignment is active.'): string {
  return [
    '## 💬 Comment answered',
    '',
    'The recorded assignment evidence supports a bounded reply.',
    '',
    '## Response',
    '',
    response,
    '',
    '## 📤 Proposed GitHub reply',
    '',
    `> ${reply}`,
  ].join('\n');
}

describe('channels/github/utils/comment-response', () => {
  it('should select one rich response and extract its quoted public reply', () => {
    const payload = {
      text: commentResponse(
        'I have the plan ready, but I do not have a newly verified update yet.',
        'The assignment is active and its plan is recorded.',
      ),
    };

    assert.equal(assertGitHubNotificationCommentResponse([payload]), payload);
    assert.equal(
      githubNotificationCommentReply(payload),
      'I have the plan ready, but I do not have a newly verified update yet.',
    );
  });

  it('should accept flexible private markdown around one quoted public reply', () => {
    const payload = {
      text: [
        '### Recorded status',
        '',
        'The assignment is active and its plan is recorded.',
        '',
        '## 📤 Proposed GitHub reply',
        '',
        '> I have the plan ready.',
      ].join('\n'),
    };

    assert.equal(assertGitHubNotificationCommentResponse([payload]), payload);
    assert.equal(githubNotificationCommentReply(payload), 'I have the plan ready.');
  });

  it('should prefer one complete ordinary final over commentary', () => {
    const commentary = {
      isCommentary: true,
      text: commentResponse('I am reviewing it.', 'A commentary response.'),
    };
    const final = {
      text: commentResponse('I have reviewed it.', 'The final private response.'),
    };

    assert.equal(assertGitHubNotificationCommentResponse([commentary, final]), final);
    assert.equal(assertGitHubNotificationCommentResponse([commentary]), commentary);
  });

  it('should preserve legacy plaintext responses during the migration window', () => {
    const payload = {
      text: [
        'GITHUB_REPLY: I have the plan ready.',
        'RESPONSE:',
        'The assignment is active and its plan is recorded.',
      ].join('\n'),
    };

    assert.equal(assertGitHubNotificationCommentResponse([payload]), payload);
    assert.equal(githubNotificationCommentReply(payload), 'I have the plan ready.');
  });

  it('should reject missing ambiguous mixed or empty complete responses', () => {
    for (const payloads of [
      [{ text: '## Response\n\nPrivate only.' }],
      [{ text: commentResponse('First.') }, { text: commentResponse('Second.') }],
      [
        {
          text: `${commentResponse('Public.')}\nGITHUB_REPLY: Legacy.\nRESPONSE:\nLegacy private.`,
        },
      ],
      [
        {
          text: '## 📤 Proposed GitHub reply\n\n> Public.',
        },
      ],
    ]) {
      assert.throws(
        () => assertGitHubNotificationCommentResponse(payloads),
        GitHubNotificationCommentResponseError,
      );
    }
  });

  it('should reject duplicate or unsafe public reply candidates', () => {
    assert.throws(
      () =>
        githubNotificationCommentReply({
          text: [
            commentResponse('First.'),
            '',
            '## 📤 Proposed GitHub reply',
            '',
            '> Second.',
          ].join('\n'),
        }),
      GitHubNotificationCommentResponseError,
    );
    assert.throws(
      () =>
        githubNotificationCommentReply({
          text: commentResponse('I found GH_TOKEN=secret-value.'),
        }),
      GitHubNotificationPublicationError,
    );
  });
});
