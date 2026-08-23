import assert from 'node:assert/strict';

import {
  GitHubNotificationPrivateResponseError,
  githubNotificationPlanningPrivateResponse,
  githubNotificationPrivateResponse,
} from '../channels/github/conversation/private-response.ts';

describe('channels/github/conversation/private-response', () => {
  it('should accept one ordinary rich markdown response without parsing its structure', () => {
    const response = [
      'The private response is ready.',
      '',
      '## Arbitrary heading',
      '',
      '> A quote and `code` remain private.',
    ].join('\n');

    assert.equal(githubNotificationPrivateResponse([{ text: response }]), response);
  });

  it('should ignore commentary when selecting the ordinary final', () => {
    assert.equal(
      githubNotificationPrivateResponse([
        { isCommentary: true, text: 'A progress update.' },
        { text: 'The complete private response.' },
      ]),
      'The complete private response.',
    );
  });

  it('should reject missing and ambiguous ordinary responses', () => {
    for (const payloads of [
      [{ isCommentary: true, text: 'Only commentary.' }],
      [{ text: '' }],
      [{ text: 'One.' }, { text: 'Two.' }],
    ]) {
      assert.throws(
        () => githubNotificationPrivateResponse(payloads),
        (error: unknown) => error instanceof GitHubNotificationPrivateResponseError,
      );
    }
  });

  it('should enforce assignment report sections for a plan or questions', () => {
    const plan =
      '## Assessment\n\nThe user needs a corrected result.\n\n## Plan\n\nUpdate and test it.';
    const questions =
      '## Assessment\n\nThe user goal is clear, but one constraint is missing.\n\n## Questions\n\n1. Which behavior should win?';

    assert.equal(githubNotificationPlanningPrivateResponse(plan), plan);
    assert.equal(githubNotificationPlanningPrivateResponse(questions), questions);
    assert.throws(
      () => githubNotificationPlanningPrivateResponse('## Question\n\nWhich behavior should win?'),
      (error: unknown) =>
        error instanceof GitHubNotificationPrivateResponseError &&
        error.code === 'github-notification-planning-private-response-invalid',
    );
  });
});
