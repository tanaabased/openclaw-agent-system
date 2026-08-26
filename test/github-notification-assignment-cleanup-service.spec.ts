import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import GitHubNotificationAssignmentCleanupService from '../channels/github/intake/assignment-cleanup-service.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace';
const config: OpenClawConfig = {
  agents: { list: [{ id: agentId, workspace: workspaceDir }] },
  bindings: [
    {
      agentId,
      match: { accountId: agentId, channel: githubNotificationChannelId },
      session: { dmScope: 'per-account-channel-peer' },
      type: 'route',
    },
  ],
  channels: {
    [githubNotificationChannelId]: { accounts: { [agentId]: { enabled: true } } },
  },
};

function fixture(
  options: {
    active?: boolean;
    implementation?: 'completed' | 'pending';
    session?: 'archived' | 'failed' | 'missing' | 'pinned';
    worktree?: 'dirty' | 'failed' | 'missing' | 'removed' | 'unsafe';
  } = {},
) {
  const item = notificationMonitorState().items[notificationItemKey]!;
  item.disposition = 'retired';
  item.reasonCode = 'item-closed';
  item.intake = {
    assignmentEventId: item.assignmentEventNodeId!,
    providerRetirementVerifiedAt: 10,
    stage: 'retired',
    worktreeBranch: 'issue-7',
    worktreePath: '/worktrees/issue-7',
  };
  const conversationId = githubNotificationConversationId({
    itemNumber: item.number,
    lifecycleId: item.lifecycleId,
    repositoryId: item.repositoryNodeId,
  });
  let cleanupCalls = 0;
  const lifecycle = new GitHubIssueLifecycle({
    async cleanupGitHub() {
      cleanupCalls += 1;
      return { status: options.worktree ?? 'removed' };
    },
    async inspectGitHub() {
      return undefined;
    },
    async prepareGitHub() {
      throw new Error('not used');
    },
  });
  const service = new GitHubNotificationAssignmentCleanupService({
    conversations: {
      async read() {
        return {
          agentId,
          conversations: {
            [conversationId]: {
              ...(options.active
                ? { activeTurn: { eventId: 'comment' as const, sourceId: 'C_comment' } }
                : {}),
              assignmentResponse: {
                commentDatabaseId: 1,
                commentNodeId: 'C_response',
                publicText: 'Plan',
                publicTextDigest: '0'.repeat(64),
                status: 'published' as const,
                target: 'unused',
              },
              baselineEstablished: true,
              implementation: { status: options.implementation ?? 'completed' },
              itemKey: notificationItemKey,
              lifecycleId: 'issue' as const,
              mode: 'work' as const,
              revisions: {},
            },
          },
          schemaVersion: 7 as const,
          workspaceDir,
        };
      },
    },
    readConfig: () => config,
    sessions: {
      async archive() {
        if (options.session === 'failed') throw new Error('private session failure');
        return options.session ?? 'archived';
      },
    },
  });
  return {
    cleanupCalls: () => cleanupCalls,
    input: { agentId, item, lifecycle, workspaceDir },
    service,
  };
}

describe('channels/github/intake/assignment-cleanup-service', () => {
  it('should archive a completed session and remove its clean managed worktree', async () => {
    const test = fixture();
    assert.deepEqual(await test.service.cleanup(test.input), {
      reasonCode: 'github-notification-cleanup-worktree-removed',
      session: 'archived',
      status: 'completed',
      worktree: 'removed',
    });
    assert.equal(test.cleanupCalls(), 1);
  });

  it('should retain pinned, active, and incomplete assignments', async () => {
    for (const options of [
      { session: 'pinned' as const },
      { active: true },
      { implementation: 'pending' as const },
    ]) {
      const test = fixture(options);
      const result = await test.service.cleanup(test.input);
      assert.equal(result.status, 'skipped');
      assert.equal(test.cleanupCalls(), 0);
    }
  });

  it('should retain dirty and unsafe worktrees with retry-safe outcomes', async () => {
    for (const worktree of ['dirty', 'unsafe'] as const) {
      const test = fixture({ worktree });
      const result = await test.service.cleanup(test.input);
      assert.equal(result.status, 'skipped');
      assert.equal(result.worktree, worktree);
      assert.equal(result.session, 'archived');
    }
  });

  it('should complete idempotently when session and worktree are already missing', async () => {
    const test = fixture({ session: 'missing', worktree: 'missing' });
    assert.deepEqual(await test.service.cleanup(test.input), {
      reasonCode: 'github-notification-cleanup-worktree-missing',
      session: 'missing',
      status: 'completed',
      worktree: 'missing',
    });
  });

  it('should record a retry-safe session failure without exposing its details', async () => {
    const test = fixture({ session: 'failed' });
    assert.deepEqual(await test.service.cleanup(test.input), {
      reasonCode: 'github-notification-cleanup-session-failed',
      session: 'failed',
      status: 'failed',
      worktree: 'not-applicable',
    });
    assert.equal(test.cleanupCalls(), 0);
  });
});
