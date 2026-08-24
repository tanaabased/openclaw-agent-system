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
      githubNotificationPublicationText('assignment-response', [
        { text: 'I reviewed the assignment and have a plan ready.' },
      ]),
      'I reviewed the assignment and have a plan ready.',
    );
  });

  it('should allow harmless paths and long repository identifiers', () => {
    const text =
      'I reviewed `/Users/runner/work/example/channels/github/publication.ts`, will create `assignment-fixture-32681544592-1.txt`, and based the plan on commit `0123456789abcdef0123456789abcdef01234567`.';

    assert.equal(githubNotificationPublicationText('assignment-response', [{ text }]), text);
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

  it('should classify secret safety rejections without retaining candidate text', () => {
    for (const [text, safetyCategory] of [
      ['OPENAI_API_KEY=value', 'environment-assignment'],
      ['See @pirog.', 'mention'],
      ['Token ghp_abcdef', 'credential-prefix'],
    ] as const) {
      assert.throws(
        () => githubNotificationPublicationText('github-reply', [{ text }]),
        (error: unknown) =>
          error instanceof GitHubNotificationPublicationError &&
          error.code === 'github-notification-publication-secret-safety-rejected' &&
          error.safetyCategory === safetyCategory &&
          !error.message.includes(text),
      );
    }
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
      () => githubNotificationPublicationText('github-reply', [{ mediaUrl: '/tmp/result.png' }]),
      /not safe to publish/u,
    );
  });
});
