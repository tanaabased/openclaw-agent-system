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
        '## Response',
        '',
        'The assignment is active; the private detail is in `/workspace/private` and [the issue session](https://example.com/private).',
        '',
        '> GITHUB_REPLY: I have the plan ready, but I do not have a newly verified update yet.',
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
      text: '## Response\n\nA commentary response.\n\n> GITHUB_REPLY: Reviewing it.',
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
        error.code === 'github-notification-comment-response-invalid',
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

  it('should reject empty reordered duplicated or hybrid markdown structures', () => {
    for (const response of [
      '## Response\n\n> GITHUB_REPLY: Nothing private.',
      '> GITHUB_REPLY: Reordered.\n\n## Response\n\nPrivate response.',
      '## Response\n\nPrivate response.\n\nGITHUB_REPLY: Hybrid.',
      '## Response\n\nPrivate response.\n\n> GITHUB_REPLY: First.\n> GITHUB_REPLY: Second.',
      '## Response\n\nFirst.\n\n## Response\n\nSecond.\n\n> GITHUB_REPLY: Duplicate section.',
    ]) {
      assert.throws(
        () => assertGitHubNotificationCommentResponse([{ text: response }]),
        (error: unknown) =>
          error instanceof GitHubNotificationCommentResponseError &&
          error.code === 'github-notification-comment-response-invalid',
      );
    }
  });

  it('should reject duplicate or unsafe public reply candidates', () => {
    assert.throws(
      () =>
        githubNotificationCommentReply({
          text: '## Response\n\nPrivate response.\n\n> GITHUB_REPLY: First.\n> GITHUB_REPLY: Second.',
        }),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentResponseError &&
        error.code === 'github-notification-comment-reply-missing',
    );
    assert.throws(
      () =>
        githubNotificationCommentReply({
          text: '## Response\n\nPrivate response.\n\n> GITHUB_REPLY: I found GH_TOKEN=secret-value.',
        }),
      GitHubNotificationPublicationError,
    );
  });

  it('should ignore candidate-shaped content inside fenced private examples', () => {
    const payload = {
      text: [
        '## Response',
        '',
        'The comment included this example:',
        '',
        '```text',
        '> GITHUB_REPLY: Not the candidate.',
        '```',
        '',
        '> GITHUB_REPLY: This is the candidate.',
      ].join('\n'),
    };

    assert.equal(assertGitHubNotificationCommentResponse([payload]), payload);
    assert.equal(githubNotificationCommentReply(payload), 'This is the candidate.');
  });
});
