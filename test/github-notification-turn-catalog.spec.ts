import assert from 'node:assert/strict';

import GitHubNotificationTurnCatalog, {
  GitHubNotificationTurnCatalogError,
  githubNotificationCurrentTurnIdentity,
  githubNotificationSupportedTurnIdentities,
} from '../channels/github/conversation/turn-catalog.ts';
import githubNotificationAssignmentEvent from '../channels/github/events/assignment.ts';
import githubNotificationCommentEvent from '../channels/github/events/comment.ts';
import GitHubNotificationEventRegistry from '../channels/github/events/registry.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import { GitHubNotificationLifecycleModeSupportError } from '../channels/github/lifecycles/mode-support.ts';
import GitHubPullRequestLifecycle from '../channels/github/lifecycles/pull-request.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import GitHubNotificationModeRegistry from '../channels/github/modes/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';

function definitions() {
  return {
    events: new GitHubNotificationEventRegistry([
      githubNotificationAssignmentEvent,
      githubNotificationCommentEvent,
    ]),
    lifecycles: new GitHubNotificationLifecycleRegistry([
      new GitHubIssueLifecycle({
        async inspectGitHub() {
          return undefined;
        },
        async prepareGitHub() {
          throw new Error('not used');
        },
      }),
      new GitHubPullRequestLifecycle(),
    ]),
    modes: new GitHubNotificationModeRegistry([githubNotificationWorkMode]),
  };
}

describe('channels/github/conversation/turn-catalog', () => {
  it('should admit only the declared model-turn tuple', () => {
    const catalog = new GitHubNotificationTurnCatalog(
      githubNotificationSupportedTurnIdentities,
      definitions(),
    );

    assert.deepEqual(
      catalog.resolve(githubNotificationCurrentTurnIdentity),
      githubNotificationCurrentTurnIdentity,
    );
    assert.throws(
      () =>
        catalog.resolve({
          eventId: 'assignment',
          lifecycleId: 'issue',
          modeId: 'work',
        }),
      (error: unknown) =>
        error instanceof GitHubNotificationTurnCatalogError &&
        error.code === 'github-notification-turn-unsupported',
    );
  });

  it('should reject an observe-only event declared as a model turn', () => {
    assert.throws(
      () =>
        new GitHubNotificationTurnCatalog(
          [{ eventId: 'assignment', lifecycleId: 'issue', modeId: 'work' }],
          definitions(),
        ),
      (error: unknown) =>
        error instanceof GitHubNotificationTurnCatalogError &&
        error.code === 'github-notification-turn-event-not-model',
    );
  });

  it('should validate lifecycle compatibility when the catalog is assembled', () => {
    assert.throws(
      () =>
        new GitHubNotificationTurnCatalog(
          [{ eventId: 'comment', lifecycleId: 'pull-request', modeId: 'work' }],
          definitions(),
        ),
      (error: unknown) =>
        error instanceof GitHubNotificationLifecycleModeSupportError &&
        error.code === 'github-notification-lifecycle-mode-unsupported',
    );
  });

  it('should reject duplicate model-turn declarations', () => {
    assert.throws(
      () =>
        new GitHubNotificationTurnCatalog(
          [githubNotificationCurrentTurnIdentity, githubNotificationCurrentTurnIdentity],
          definitions(),
        ),
      /Duplicate GitHub notification model turn issue:work:comment/u,
    );
  });
});
