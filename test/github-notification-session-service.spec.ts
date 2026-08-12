import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { GitHubNotificationAssignmentEvent } from '../channels/github/channel.ts';
import GitHubNotificationSessionService from '../channels/github/lib/session-service.ts';
import { resolveNotificationRoute } from '../channels/github/utils/routing.ts';

const config: OpenClawConfig = {
  agents: { list: [{ id: 'data', workspace: '/workspace/data' }] },
  channels: {
    'agent-system-github': { accounts: { data: { enabled: true } } },
  },
  bindings: [
    {
      type: 'route',
      agentId: 'data',
      match: { channel: 'agent-system-github', accountId: 'data' },
      session: { dmScope: 'per-account-channel-peer' },
    },
  ],
};
const desired = {
  agentId: 'data',
  enabled: true,
  workspaceDir: '/workspace/data',
};
const event: GitHubNotificationAssignmentEvent = {
  id: 'assignment-event-1',
  itemNumber: 42,
  itemType: 'issue',
  repositoryId: 'R_kgDOExample',
  timestamp: 1_786_400_000_000,
  title: 'GitHub issue #42 assignment',
};
const route = resolveNotificationRoute(config, desired, 'github:R_kgDOExample:42');
const assignmentInput = {
  agentId: 'data',
  delivery: {
    assignmentEventId: event.id,
    schemaVersion: 1 as const,
    stage: 'worktree-ready' as const,
    workId: 'issue-42',
    worktreeBranch: 'agent/data/github-42',
    worktreePath: '/workspace/data/.agent-system/worktrees/github-42',
  },
  item: {
    assignmentActorNodeId: 'U_actor',
    assignmentEventNodeId: event.id,
    disposition: 'approved' as const,
    itemDatabaseId: 42,
    itemNodeId: 'I_item',
    itemType: 'issue' as const,
    lastObservedAt: 1,
    number: 42,
    reasonCode: 'assignment-approved',
    repositoryCloneUrl: 'https://github.com/tanaabased/openclaw-agent-system.git',
    repositoryDatabaseId: 7,
    repositoryDefaultBranch: 'main',
    repositoryName: 'openclaw-agent-system',
    repositoryNodeId: event.repositoryId,
    repositoryOwner: 'tanaabased',
    repositoryOwnerNodeId: 'O_owner',
    repositoryPermission: 'write' as const,
  },
  worktree: {
    branch: 'agent/data/github-42',
    path: '/workspace/data/.agent-system/worktrees/github-42',
  },
  workspaceDir: '/workspace/data',
};

function createService(
  overrides: { config?: OpenClawConfig; record?: () => void } = {},
): GitHubNotificationSessionService {
  return new GitHubNotificationSessionService({
    readConfig: () => overrides.config ?? config,
    recordInboundSession: (async () => overrides.record?.()) as never,
  });
}

describe('channels/github/lib/session-service', () => {
  it('should record the routed session without dispatching an agent turn', async () => {
    let records = 0;
    const service = createService({
      record: () => {
        records += 1;
      },
    });

    const observed = await service.recordSession(assignmentInput);

    assert.equal(records, 1);
    assert.deepEqual(observed, { key: route.sessionKey, status: 'active' });
  });

  it('should prepare a deterministic observe-only session record', async () => {
    const service = createService();
    const turn = service.prepareTurn({
      config,
      event,
      label: 'tanaabased/openclaw-agent-system#42',
      route,
      worktreeBranch: assignmentInput.worktree.branch,
      worktreePath: assignmentInput.worktree.path,
    });

    assert.equal(turn.channel, 'agent-system-github');
    assert.equal(turn.accountId, 'data');
    assert.equal(turn.routeSessionKey, route.sessionKey);
    assert.equal(turn.ctxPayload.SessionKey, route.sessionKey);
    assert.equal(turn.ctxPayload.InboundEventKind, 'user_request');
    assert.equal(turn.ctxPayload.BodyForAgent, 'GitHub issue #42 was assigned to this agent.');
    const context = turn.ctxPayload as unknown as Record<string, unknown>;
    assert.equal(context.githubWorktreeBranch, assignmentInput.worktree.branch);
    assert.equal(context.githubWorktreePath, assignmentInput.worktree.path);
    assert.deepEqual(turn.record, { createIfMissing: true });
    await assert.rejects(turn.runDispatch(), /must not dispatch an agent turn/u);
  });

  it('should fail closed when the configured binding resolves another agent', async () => {
    const service = createService({
      config: {
        ...config,
        bindings: [
          {
            type: 'route',
            agentId: 'other',
            match: { channel: 'agent-system-github', accountId: 'data' },
          },
        ],
      },
    });

    await assert.rejects(
      service.recordSession(assignmentInput),
      /does not select the expected agent/u,
    );
  });

  it('should reject relative worktree paths', () => {
    const service = createService();

    assert.throws(
      () =>
        service.prepareTurn({
          config,
          event,
          label: 'repository#42',
          route,
          worktreeBranch: assignmentInput.worktree.branch,
          worktreePath: '.agent-system/worktrees/github-42',
        }),
      /worktree paths must be an absolute path/u,
    );
  });
});
