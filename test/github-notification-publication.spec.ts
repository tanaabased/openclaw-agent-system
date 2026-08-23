import assert from 'node:assert/strict';

import {
  githubNotificationAttributedReplyText,
  githubNotificationCommenterToken,
  githubNotificationPublicationComment,
  GitHubNotificationPublicationError,
  githubNotificationPublicationMarker,
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  parseGitHubNotificationPublicationTarget,
} from '../channels/github/publication/publication.ts';
import { maximumGitHubNotificationReplyLength } from '../channels/github/publication/limits.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

describe('channels/github/publication/publication', () => {
  it('should mint one opaque target and hidden marker for a publication intent', () => {
    const target = githubNotificationPublicationTarget({
      intent: 'initial-acknowledgment',
      item: approvedNotificationItem(),
      publicationId: 'EV_assignment',
    });
    const marker = githubNotificationPublicationMarker(target);

    assert.equal(
      target,
      'github:issue:R_repo:12:publication:initial-acknowledgment:cf83e6cc2cf5186ea777b680a7005925',
    );
    assert.deepEqual(parseGitHubNotificationPublicationTarget(target), {
      conversationId: 'github:issue:R_repo:12',
      digest: 'cf83e6cc2cf5186ea777b680a7005925',
      intent: 'initial-acknowledgment',
    });
    assert.equal(
      githubNotificationPublicationComment('I have this one.', marker),
      `I have this one.\n\n${marker}`,
    );
  });

  it('should accept bounded text for each explicit publication intent', () => {
    assert.equal(
      githubNotificationPublicationText('initial-acknowledgment', [
        { text: "Gladly — I've picked this one up." },
      ]),
      "Gladly — I've picked this one up.",
    );
    assert.equal(
      githubNotificationPublicationText('github-reply', [
        {
          text: [
            '## Result',
            '',
            `The \`notification\` flow is ready, ${githubNotificationCommenterToken}.`,
            '',
            '| Check | Status |',
            '| --- | --- |',
            '| [Build](https://github.com/tanaabased/example/actions) | Passing |',
          ].join('\n'),
        },
      ]),
      [
        '## Result',
        '',
        `The \`notification\` flow is ready, ${githubNotificationCommenterToken}.`,
        '',
        '| Check | Status |',
        '| --- | --- |',
        '| [Build](https://github.com/tanaabased/example/actions) | Passing |',
      ].join('\n'),
    );
    assert.equal(
      githubNotificationPublicationText('planning-outcome', [
        { text: 'I reviewed the assignment and have a plan ready.' },
      ]),
      'I reviewed the assignment and have a plan ready.',
    );
  });

  it('should substitute the verified commenter wherever the reserved token reads naturally', () => {
    assert.equal(
      githubNotificationAttributedReplyText(
        `Thanks for flagging this, ${githubNotificationCommenterToken}. I checked the flow.`,
        'emoriwan',
      ),
      'Thanks for flagging this, @emoriwan. I checked the flow.',
    );
    assert.equal(
      githubNotificationAttributedReplyText('I checked the flow.', 'emoriwan'),
      '@emoriwan\n\nI checked the flow.',
    );
    assert.equal(
      githubNotificationAttributedReplyText(
        `I checked the flow. Thanks, ${githubNotificationCommenterToken}`,
        'emoriwan',
      ),
      'I checked the flow. Thanks, @emoriwan',
    );
  });

  it('should enforce the shared reply length boundary', () => {
    const maximum = Array.from({ length: maximumGitHubNotificationReplyLength }, (_, index) =>
      index % 2 === 0 ? 'a' : ' ',
    )
      .join('')
      .replace(/ $/u, 'a');

    assert.equal(githubNotificationPublicationText('github-reply', [{ text: maximum }]), maximum);
    assert.throws(
      () => githubNotificationPublicationText('github-reply', [{ text: `${maximum}a` }]),
      /not safe to publish/u,
    );
  });

  it('should reject unsupported shapes and secret-sensitive text', () => {
    assert.throws(
      () =>
        githubNotificationPublicationText('initial-acknowledgment', [
          { text: 'I have this.\nI am starting.' },
        ]),
      /not safe to publish/u,
    );
    assert.throws(
      () => githubNotificationPublicationText('github-reply', [{ text: 'Token ghp_abcdef' }]),
      /not safe to publish/u,
    );
    assert.throws(
      () => githubNotificationPublicationText('github-reply', [{ text: 'See @pirog.' }]),
      /not safe to publish/u,
    );
    for (const text of [
      `Thanks${githubNotificationCommenterToken}.`,
      `Thanks, ${githubNotificationCommenterToken}${githubNotificationCommenterToken}.`,
      `[${githubNotificationCommenterToken}](https://github.com/pirog) thanks.`,
      `${githubNotificationCommenterToken}-other thanks.`,
      githubNotificationCommenterToken,
    ]) {
      assert.throws(
        () => githubNotificationPublicationText('github-reply', [{ text }]),
        (error: unknown) =>
          error instanceof GitHubNotificationPublicationError &&
          error.code === 'github-notification-publication-commenter-token-invalid',
      );
    }
    assert.throws(
      () =>
        githubNotificationPublicationText('github-reply', [
          { text: 'Read `/Users/pirog/private.txt`.' },
        ]),
      /not safe to publish/u,
    );
    assert.throws(
      () => githubNotificationPublicationText('github-reply', [{ mediaUrl: '/tmp/result.png' }]),
      /not safe to publish/u,
    );
  });
});
