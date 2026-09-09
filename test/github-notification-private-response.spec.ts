import assert from 'node:assert/strict';

import {
  GitHubNotificationPrivateResponseError,
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

  it('should ignore supplemental lanes and notices when selecting the ordinary final', () => {
    assert.equal(
      githubNotificationPrivateResponse([
        { isCommentary: true, text: 'A progress update.' },
        { isCompactionNotice: true, text: 'Compaction completed.' },
        { isFallbackNotice: true, text: 'Model fallback completed.' },
        { isReasoning: true, text: 'Internal reasoning.' },
        { isStatusNotice: true, text: 'Tool execution completed.' },
        { text: 'The complete private response.' },
      ]),
      'The complete private response.',
    );
  });

  it('should reject missing and ambiguous ordinary responses', () => {
    for (const payloads of [
      [{ isCommentary: true, text: 'Only commentary.' }],
      [{ isCompactionNotice: true, text: 'Only compaction.' }],
      [{ isFallbackNotice: true, text: 'Only fallback.' }],
      [{ isReasoning: true, text: 'Only reasoning.' }],
      [{ isStatusNotice: true, text: 'Only status.' }],
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
