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
  title: 'Implement the notification session',
};
const route = resolveNotificationRoute(config, desired, 'github:R_kgDOExample:42');
const assignmentInput = {
  agentId: 'data',
  delivery: {
    assignmentEventId: event.id,
    briefingIdempotencyKey: event.id,
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
  overrides: {
    config?: OpenClawConfig;
    dispatch?: () => void;
    record?: () => void;
  } = {},
): GitHubNotificationSessionService {
  return new GitHubNotificationSessionService({
    dispatchReplyWithBufferedBlockDispatcher: (async () => {
      overrides.dispatch?.();
      return {};
    }) as never,
    loadBriefing: async () => ({
      assignmentActor: { login: 'pirog', nodeId: 'U_actor', type: 'User' },
      assignmentAt: '2026-08-11T12:00:00Z',
      projection: {
        bodyExcerpt: 'Implement the notification session.',
        bodyTruncated: false,
        labels: ['feature'],
        labelsTruncated: false,
        title: event.title,
        url: 'https://github.com/tanaabased/openclaw-agent-system/issues/42',
      },
    }),
    readConfig: () => overrides.config ?? config,
    recordInboundSession: (async () => overrides.record?.()) as never,
  });
}

describe('channels/github/lib/session-service', () => {
  it('should let the channel inbound lifecycle record and dispatch the routed session', async () => {
    let dispatches = 0;
    let records = 0;
    const service = createService({
      dispatch: () => {
        dispatches += 1;
      },
      record: () => {
        records += 1;
      },
    });

    const observed = await service.dispatchBriefing(assignmentInput);

    assert.equal(records, 1);
    assert.equal(dispatches, 1);
    assert.deepEqual(observed, { key: route.sessionKey, status: 'active' });
  });

  it('should prepare a local-only no-tools turn in the managed worktree', () => {
    const service = createService();
    const turn = service.prepareTurn({
      briefing: 'Review GitHub issue #42 and summarize the requested work.',
      config,
      event,
      label: 'tanaabased/openclaw-agent-system#42',
      route,
      worktreeBranch: assignmentInput.worktree.branch,
      worktreePath: assignmentInput.worktree.path,
    });

    assert.equal(turn.channel, 'agent-system-github');
    assert.equal(turn.accountId, 'data');
    assert.equal(turn.agentId, 'data');
    assert.equal(turn.routeSessionKey, route.sessionKey);
    assert.equal(turn.ctxPayload.SessionKey, route.sessionKey);
    assert.equal(turn.ctxPayload.InboundEventKind, 'user_request');
    assert.equal(
      turn.ctxPayload.BodyForAgent,
      'Review GitHub issue #42 and summarize the requested work.',
    );
    const context = turn.ctxPayload as unknown as Record<string, unknown>;
    assert.equal(context.githubWorktreeBranch, assignmentInput.worktree.branch);
    assert.equal(context.githubWorktreePath, assignmentInput.worktree.path);
    assert.deepEqual(turn.toolsAllow, []);
    assert.deepEqual(turn.replyOptions, {
      disableTools: true,
      sourceReplyDeliveryMode: 'message_tool_only',
      suppressDefaultToolProgressMessages: true,
      suppressTyping: true,
      toolsAllow: [],
    });
    assert.deepEqual(turn.record, { createIfMissing: true });
    assert.equal(turn.afterRecord, undefined);
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
      service.dispatchBriefing(assignmentInput),
      /does not select the expected agent/u,
    );
  });

  it('should reject unbounded briefings and relative worktree paths', () => {
    const service = createService();
    const common = {
      config,
      event,
      label: 'repository#42',
      route,
      worktreeBranch: assignmentInput.worktree.branch,
      worktreePath: assignmentInput.worktree.path,
    };

    assert.throws(
      () => service.prepareTurn({ ...common, briefing: 'x'.repeat(16_385) }),
      /must not exceed 16384 characters/u,
    );
    assert.throws(
      () =>
        service.prepareTurn({
          ...common,
          briefing: 'Review the assigned issue.',
          worktreePath: '.agent-system/worktrees/github-42',
        }),
      /worktree paths must be an absolute path/u,
    );
  });
});
