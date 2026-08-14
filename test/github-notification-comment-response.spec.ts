import assert from 'node:assert/strict';

import githubNotificationCommentReply, {
  assertGitHubNotificationCommentResponse,
  GitHubNotificationCommentResponseError,
} from '../channels/github/utils/comment-response.ts';
import { GitHubNotificationPublicationError } from '../channels/github/utils/publication.ts';

describe('channels/github/utils/comment-response', () => {
  it('should select one complete response and extract its safe public reply', () => {
    const payload = {
      text: [
        'GITHUB_REPLY: I have the plan ready, but I do not have a newly verified update yet.',
        'RESPONSE:',
        'The assignment is active and its plan is recorded.',
      ].join('\n'),
    };

    assert.equal(assertGitHubNotificationCommentResponse([payload]), payload);
    assert.equal(
      githubNotificationCommentReply(payload),
      'I have the plan ready, but I do not have a newly verified update yet.',
    );
  });

  it('should prefer one complete ordinary final over commentary', () => {
    const commentary = {
      isCommentary: true,
      text: 'GITHUB_REPLY: Reviewing it.\nRESPONSE:\nA commentary response.',
    };
    const final = {
      text: 'GITHUB_REPLY: I have reviewed it.\nRESPONSE:\nThe final response.',
    };

    assert.equal(assertGitHubNotificationCommentResponse([commentary, final]), final);
    assert.equal(assertGitHubNotificationCommentResponse([commentary]), commentary);
  });

  it('should reject missing or ambiguous complete responses', () => {
    assert.throws(
      () => assertGitHubNotificationCommentResponse([{ text: 'RESPONSE:\nPrivate only.' }]),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentResponseError &&
        error.code === 'github-notification-comment-response-missing',
    );
    assert.throws(
      () =>
        assertGitHubNotificationCommentResponse([
          { text: 'GITHUB_REPLY: First.\nRESPONSE:\nFirst response.' },
          { text: 'GITHUB_REPLY: Second.\nRESPONSE:\nSecond response.' },
        ]),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentResponseError &&
        error.code === 'github-notification-comment-response-invalid',
    );
  });

  it('should reject duplicate or unsafe public reply candidates', () => {
    assert.throws(
      () =>
        githubNotificationCommentReply({
          text: 'GITHUB_REPLY: First.\nGITHUB_REPLY: Second.\nRESPONSE:\nPrivate response.',
        }),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentResponseError &&
        error.code === 'github-notification-comment-reply-missing',
    );
    assert.throws(
      () =>
        githubNotificationCommentReply({
          text: 'GITHUB_REPLY: I found GH_TOKEN=secret-value.\nRESPONSE:\nPrivate response.',
        }),
      GitHubNotificationPublicationError,
    );
  });
});
