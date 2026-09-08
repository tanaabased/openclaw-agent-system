import assert from 'node:assert/strict';

import {
  GitHubNotificationPrivateResponseError,
  githubNotificationPrivateResponse,
  githubNotificationPrivateResponseDiagnostics,
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

  it('should ignore commentary and reasoning when selecting the ordinary final', () => {
    assert.equal(
      githubNotificationPrivateResponse([
        { isCommentary: true, text: 'A progress update.' },
        { isReasoning: true, text: 'Internal reasoning.' },
        { text: 'The complete private response.' },
      ]),
      'The complete private response.',
    );
  });

  it('should reject missing and ambiguous ordinary responses', () => {
    for (const payloads of [
      [{ isCommentary: true, text: 'Only commentary.' }],
      [{ isReasoning: true, text: 'Only reasoning.' }],
      [{ text: '' }],
      [{ text: 'One.' }, { text: 'Two.' }],
    ]) {
      assert.throws(
        () => githubNotificationPrivateResponse(payloads),
        (error: unknown) => error instanceof GitHubNotificationPrivateResponseError,
      );
    }
  });

  it('should summarize bounded payload shape without retaining text', () => {
    const diagnostic = githubNotificationPrivateResponseDiagnostics([
      { isReasoning: true, text: 'sensitive reasoning' },
      { channelData: { secret: 'value' }, isError: true, text: 'private response' },
    ]);

    assert.equal(
      diagnostic,
      'payload-count=2 payload-shapes=0:19:0:1:0:0:0:0:0,1:16:1:0:0:0:0:0:1 payload-shapes-truncated=false',
    );
    assert.doesNotMatch(diagnostic, /sensitive|private|secret|value/u);
  });
});
