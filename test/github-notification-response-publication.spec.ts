import assert from 'node:assert/strict';

import {
  assertGitHubNotificationResponse,
  githubNotificationResponsePublication,
} from '../channels/github/utils/response-publication.ts';

const completeResponse = {
  text: [
    'I reviewed the issue and verified the current behavior.',
    '',
    '## 📤 To GitHub',
    '',
    '> I reviewed this and have a focused implementation plan ready.',
  ].join('\n'),
};

describe('channels/github/utils/response-publication', () => {
  it('should select a complete private and public response and extract only its quote', () => {
    const payload = assertGitHubNotificationResponse([completeResponse]);
    assert.equal(
      githubNotificationResponsePublication(payload, 'planning-outcome'),
      'I reviewed this and have a focused implementation plan ready.',
    );
  });

  it('should prefer one ordinary final over a matching commentary update', () => {
    assert.equal(
      assertGitHubNotificationResponse([
        { ...completeResponse, isCommentary: true },
        completeResponse,
      ]).isCommentary,
      undefined,
    );
  });

  it('should not fall back to commentary when an ordinary response is incomplete', () => {
    assert.throws(
      () =>
        assertGitHubNotificationResponse([
          { ...completeResponse, isCommentary: true },
          { text: 'An incomplete ordinary response.' },
        ]),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'github-notification-response-publication-missing',
    );
  });

  it('should reject missing private content, duplicate headings, and unsafe candidates', () => {
    const cases = [
      { text: '## 📤 To GitHub\n\n> Public only.' },
      { text: `${completeResponse.text}\n\n## 📤 To GitHub\n\n> Duplicate.` },
      { text: 'Private.\n\n## 📤 To GitHub\n\nNot quoted.' },
    ];
    for (const payload of cases) {
      assert.throws(
        () => assertGitHubNotificationResponse([payload]),
        /complete public candidate/u,
      );
    }
    assert.throws(
      () =>
        githubNotificationResponsePublication(
          {
            text: 'Private.\n\n## 📤 To GitHub\n\n> Token ghp_abcdefghijklmnopqrstuvwxyz',
          },
          'github-reply',
        ),
      /not safe to publish/u,
    );
  });
});
