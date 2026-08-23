import assert from 'node:assert/strict';

import GitHubNotificationTurnCatalog, {
  GitHubNotificationTurnCatalogError,
  githubNotificationIssueWorkCommentTurnIdentity,
  githubNotificationSupportedTurnIdentities,
} from '../channels/github/conversation/turn-catalog.ts';
import { GitHubNotificationLifecycleModeSupportError } from '../channels/github/lifecycles/mode-support.ts';
import { createGitHubNotificationTurnDefinitions } from './github-notification-turn-fixtures.ts';

function definitions() {
  return createGitHubNotificationTurnDefinitions({ includePullRequest: true });
}

describe('channels/github/conversation/turn-catalog', () => {
  it('should admit only the declared model-turn tuple', () => {
    const catalog = new GitHubNotificationTurnCatalog(
      githubNotificationSupportedTurnIdentities,
      definitions(),
    );

    const definition = catalog.resolve(githubNotificationIssueWorkCommentTurnIdentity);

    assert.deepEqual(definition.identity, githubNotificationIssueWorkCommentTurnIdentity);
    assert.equal(definition.eventTurn.kind, 'model');
    assert.equal(definition.lifecycle.id, 'issue');
    assert.equal(definition.mode.policy.id, 'work');
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
          [
            githubNotificationIssueWorkCommentTurnIdentity,
            githubNotificationIssueWorkCommentTurnIdentity,
          ],
          definitions(),
        ),
      /Duplicate GitHub notification model turn issue:work:comment/u,
    );
  });
});
