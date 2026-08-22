import assert from 'node:assert/strict';

import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubPullRequestLifecycle from '../channels/github/lifecycles/pull-request.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import {
  approvedNotificationItem,
  approvedPullRequestNotificationItem,
} from './github-notification-fixtures.ts';

describe('channels/github/lifecycles', () => {
  it('should classify an issue and own its trusted worktree input', async () => {
    const calls: unknown[] = [];
    const issue = approvedNotificationItem();
    const lifecycle = new GitHubIssueLifecycle({
      async inspectGitHub(input) {
        calls.push(input);
        return { branch: 'issue-7', path: '/workspace/worktrees/issue-7' };
      },
      async prepareGitHub() {
        throw new Error('not used');
      },
    });
    const registry = new GitHubNotificationLifecycleRegistry([
      lifecycle,
      new GitHubPullRequestLifecycle(),
    ]);
    const selected = registry.resolve(issue.lifecycleId);

    assert.equal(selected.id, 'issue');
    assert.equal(selected.worktree.required, true);
    if (!selected.worktree.required) assert.fail('expected an issue worktree owner');
    await selected.worktree.inspect({
      agentId: 'tanaabot',
      intake: issue.intake!,
      item: issue,
      workspaceDir: '/workspace',
    });
    assert.deepEqual(calls, [
      {
        agentId: 'tanaabot',
        cloneUrl: issue.repositoryCloneUrl,
        defaultBranch: issue.repositoryDefaultBranch,
        itemDatabaseId: issue.itemDatabaseId,
        itemType: 'issue',
        repositoryDatabaseId: issue.repositoryDatabaseId,
      },
    ]);
    assert.deepEqual(
      lifecycle.context.project({
        item: issue,
        worktree: { branch: 'issue-7', path: '/workspace/worktrees/issue-7' },
      }),
      {
        item: {
          lifecycleId: 'issue',
          number: issue.number,
          repositoryName: issue.repositoryName,
          repositoryOwner: issue.repositoryOwner,
        },
        worktree: { branch: 'issue-7', path: '/workspace/worktrees/issue-7' },
      },
    );
    assert.equal(lifecycle.assignmentSession.enabled, true);
    assert.deepEqual(lifecycle.commentTurns, { enabled: true });
    assert.ok(lifecycle.modeSupport.work);
  });

  it('should classify a direct pull request without assigning worktree ownership', () => {
    const registry = new GitHubNotificationLifecycleRegistry([new GitHubPullRequestLifecycle()]);

    const selected = registry.resolve(approvedPullRequestNotificationItem().lifecycleId);

    assert.equal(selected.id, 'pull-request');
    assert.deepEqual(selected.worktree, { required: false });
    assert.equal(selected.assignmentSession.enabled, false);
    assert.deepEqual(selected.commentTurns, { enabled: false });
    assert.deepEqual(selected.modeSupport, {});
    assert.deepEqual(selected.context.project({ item: approvedPullRequestNotificationItem() }), {
      item: {
        lifecycleId: 'pull-request',
        number: 13,
        repositoryName: 'example',
        repositoryOwner: 'tanaabased',
      },
      pullRequest: {
        authorNodeId: 'U_actor',
        baseRef: 'main',
        draft: false,
        headRef: 'notification-pr',
        headRepositoryDatabaseId: 3,
        headRepositoryNodeId: 'R_repo',
        headSha: 'a'.repeat(40),
      },
    });
  });

  it('should reject duplicate lifecycle owners', () => {
    assert.throws(
      () =>
        new GitHubNotificationLifecycleRegistry([
          new GitHubPullRequestLifecycle(),
          new GitHubPullRequestLifecycle(),
        ]),
      /Duplicate GitHub notification lifecycle pull-request/u,
    );
  });
});
