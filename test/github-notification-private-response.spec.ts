import assert from 'node:assert/strict';

import {
  GitHubNotificationPrivateResponseError,
  githubNotificationPrivateResponse,
} from '../channels/github/utils/private-response.ts';

describe('channels/github/utils/private-response', () => {
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
});
