import assert from 'node:assert/strict';

import githubNotificationAssignmentEvent from '../channels/github/events/assignment.ts';
import githubNotificationCommentEvent from '../channels/github/events/comment.ts';
import GitHubNotificationEventRegistry from '../channels/github/events/registry.ts';
import {
  githubNotificationEventIds,
  isGitHubNotificationEventId,
} from '../channels/github/events/types.ts';

describe('channels/github/events/registry', () => {
  it('should resolve explicitly registered assignment and comment events', () => {
    const registry = new GitHubNotificationEventRegistry([
      githubNotificationAssignmentEvent,
      githubNotificationCommentEvent,
    ]);

    assert.deepEqual(githubNotificationEventIds, ['assignment', 'comment']);
    assert.deepEqual(registry.resolve('assignment'), githubNotificationAssignmentEvent);
    assert.equal(registry.resolve('assignment').turn.kind, 'model');
    assert.deepEqual(registry.resolve('comment'), githubNotificationCommentEvent);
    assert.equal(registry.resolve('comment').turn.kind, 'model');
  });

  it('should reject duplicate and unimplemented events', () => {
    assert.throws(
      () =>
        new GitHubNotificationEventRegistry([
          githubNotificationAssignmentEvent,
          githubNotificationAssignmentEvent,
        ]),
      /Duplicate GitHub notification event assignment/u,
    );
    assert.throws(
      () => new GitHubNotificationEventRegistry([]).resolve('comment'),
      /GitHub notification event comment is not implemented/u,
    );
  });

  it('should recognize only declared event ids', () => {
    assert.equal(isGitHubNotificationEventId('assignment'), true);
    assert.equal(isGitHubNotificationEventId('comment'), true);
    assert.equal(isGitHubNotificationEventId('review-submitted'), false);
    assert.equal(isGitHubNotificationEventId(undefined), false);
  });
});
