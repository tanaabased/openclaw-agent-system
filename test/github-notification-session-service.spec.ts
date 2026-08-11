import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import type { GitHubNotificationAssignmentEvent } from '../channels/github/channel.ts';
import {
  githubNotificationSessionExtension,
  parseGitHubNotificationSessionMetadata,
} from '../channels/github/lib/session-extension.ts';
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

describe('channels/github/lib/session-service', () => {
  it('should prepare a local-only no-tools turn in the managed worktree', async () => {
    const gatewayCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const service = new GitHubNotificationSessionService({
      dispatchReplyWithBufferedBlockDispatcher: (() => undefined) as never,
      async gatewayRequest(method, params) {
        gatewayCalls.push({ method, params });
        return { ok: true, key: route.sessionKey };
      },
      pluginId: 'agent-system',
      recordInboundSession: (async () => undefined) as never,
    });

    const turn = service.prepareTurn({
      briefing: 'Review GitHub issue #42 and summarize the requested work.',
      config,
      event,
      label: 'tanaabased/openclaw-agent-system#42',
      route,
      worktreeBranch: 'agent/data/github-42',
      worktreePath: '/workspace/data/.agent-system/worktrees/github-42',
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
    assert.deepEqual(turn.toolsAllow, []);
    assert.deepEqual(turn.replyOptions, {
      disableTools: true,
      sourceReplyDeliveryMode: 'message_tool_only',
      suppressDefaultToolProgressMessages: true,
      suppressTyping: true,
      toolsAllow: [],
    });
    assert.deepEqual(turn.record, { createIfMissing: true });

    await turn.afterRecord?.();
    assert.deepEqual(gatewayCalls, [
      {
        method: 'sessions.patch',
        params: {
          agentId: 'data',
          archived: false,
          key: route.sessionKey,
          label: 'tanaabased/openclaw-agent-system#42',
          sendPolicy: 'deny',
        },
      },
      {
        method: 'sessions.pluginPatch',
        params: {
          key: route.sessionKey,
          namespace: 'work-item',
          pluginId: 'agent-system',
          value: {
            assignmentEventId: 'assignment-event-1',
            itemNumber: 42,
            itemType: 'issue',
            repositoryId: 'R_kgDOExample',
            schemaVersion: 1,
            status: 'briefing',
            worktreeBranch: 'agent/data/github-42',
            worktreePath: '/workspace/data/.agent-system/worktrees/github-42',
          },
        },
      },
    ]);
  });

  it('should fail closed when openclaw patches another session', async () => {
    const service = new GitHubNotificationSessionService({
      dispatchReplyWithBufferedBlockDispatcher: (() => undefined) as never,
      gatewayRequest: async () => ({ ok: true, key: 'agent:other:main' }),
      pluginId: 'agent-system',
      recordInboundSession: (async () => undefined) as never,
    });
    const turn = service.prepareTurn({
      briefing: 'Review the assigned issue.',
      config,
      event,
      label: 'repository#42',
      route,
      worktreeBranch: 'agent/data/github-42',
      worktreePath: '/workspace/data/.agent-system/worktrees/github-42',
    });

    if (!turn.afterRecord) assert.fail('expected the session patch hook');
    await assert.rejects(
      async () => turn.afterRecord?.(),
      /did not patch the expected notification session/u,
    );
  });

  it('should reject unbounded briefings and relative worktree paths', () => {
    const service = new GitHubNotificationSessionService({
      dispatchReplyWithBufferedBlockDispatcher: (() => undefined) as never,
      gatewayRequest: async () => ({ ok: true, key: route.sessionKey }),
      pluginId: 'agent-system',
      recordInboundSession: (async () => undefined) as never,
    });
    const common = {
      config,
      event,
      label: 'repository#42',
      route,
      worktreeBranch: 'agent/data/github-42',
      worktreePath: '/workspace/data/.agent-system/worktrees/github-42',
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

  it('should abort before archiving a retired session without deleting it', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const service = new GitHubNotificationSessionService({
      dispatchReplyWithBufferedBlockDispatcher: (() => undefined) as never,
      async gatewayRequest(method, params) {
        calls.push({ method, params });
        if (method === 'sessions.abort') {
          return { abortedRunId: 'run-1', ok: true, status: 'aborted' };
        }
        return { key: route.sessionKey, ok: true };
      },
      pluginId: 'agent-system',
      recordInboundSession: (async () => undefined) as never,
    });

    const result = await service.retireSession({
      agentId: 'data',
      sessionKey: route.sessionKey,
    });

    assert.equal(result, 'aborted');
    assert.deepEqual(calls, [
      {
        method: 'sessions.abort',
        params: { agentId: 'data', key: route.sessionKey },
      },
      {
        method: 'sessions.patch',
        params: { agentId: 'data', archived: true, key: route.sessionKey },
      },
    ]);
    assert.equal(
      calls.some(({ method }) => method === 'sessions.delete'),
      false,
    );
  });

  it('should project only exact value-free session metadata', () => {
    const metadata = {
      assignmentEventId: 'assignment-event-1',
      itemNumber: 42,
      itemType: 'issue' as const,
      repositoryId: 'R_kgDOExample',
      schemaVersion: 1 as const,
      status: 'briefing' as const,
      worktreeBranch: 'agent/data/github-42',
      worktreePath: '/workspace/data/.agent-system/worktrees/github-42',
    };

    assert.deepEqual(parseGitHubNotificationSessionMetadata(metadata), metadata);
    assert.equal(
      parseGitHubNotificationSessionMetadata({ ...metadata, body: 'untrusted issue body' }),
      undefined,
    );
    assert.deepEqual(
      githubNotificationSessionExtension.project?.({
        sessionKey: route.sessionKey,
        state: metadata,
      }),
      metadata,
    );
  });
});
