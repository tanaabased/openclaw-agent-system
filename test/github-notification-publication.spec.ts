import assert from 'node:assert/strict';

import {
  githubNotificationPublicationComment,
  githubNotificationPublicationMarker,
  githubNotificationPublicationTarget,
  githubNotificationPublicationText,
  parseGitHubNotificationPublicationTarget,
} from '../channels/github/utils/publication.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

describe('channels/github/utils/publication', () => {
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
      githubNotificationPublicationText('github-reply', [{ text: 'The first pass is ready.' }]),
      'The first pass is ready.',
    );
    assert.equal(
      githubNotificationPublicationText('planning-outcome', [
        { text: 'I reviewed the assignment and have a plan ready.' },
      ]),
      'I reviewed the assignment and have a plan ready.',
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
    assert.throws(
      () => githubNotificationPublicationText('github-reply', [{ mediaUrl: '/tmp/result.png' }]),
      /not safe to publish/u,
    );
  });
});
