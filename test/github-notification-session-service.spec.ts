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
const sessionDependencies = {
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
  readConfig: () => config,
};
const assignmentInput = {
  agentId: 'data',
  delivery: {
    assignmentEventId: event.id,
    briefingIdempotencyKey: event.id,
    schemaVersion: 1 as const,
    stage: 'admitted' as const,
    workId: 'issue-42',
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

describe('channels/github/lib/session-service', () => {
  it('should create or adopt the exact routed session before dispatch', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const service = new GitHubNotificationSessionService({
      ...sessionDependencies,
      dispatchReplyWithBufferedBlockDispatcher: (() => undefined) as never,
      async gatewayRequest(method, params) {
        calls.push({ method, params });
        return method === 'sessions.create'
          ? { key: route.sessionKey, ok: true, sessionId: 'session-1' }
          : { key: route.sessionKey, ok: true };
      },
      pluginId: 'agent-system',
      recordInboundSession: (async () => undefined) as never,
    });

    const prepared = await service.prepare(assignmentInput);

    assert.deepEqual(prepared, { id: 'session-1', key: route.sessionKey, status: 'ready' });
    assert.deepEqual(
      calls.map(({ method }) => method),
      ['sessions.create', 'sessions.patch'],
    );
    assert.equal(calls[0]?.params?.key, route.sessionKey);
    assert.equal(calls[1]?.params?.sendPolicy, 'deny');
  });

  it('should adopt a completed claimed briefing from session history', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const service = new GitHubNotificationSessionService({
      ...sessionDependencies,
      dispatchReplyWithBufferedBlockDispatcher: (() => undefined) as never,
      async gatewayRequest(method, params) {
        calls.push({ method, params });
        if (method === 'sessions.describe') {
          return {
            session: {
              archived: false,
              key: route.sessionKey,
              pluginExtensions: [
                {
                  namespace: 'work-item',
                  pluginId: 'agent-system',
                  value: {
                    assignmentEventId: event.id,
                    itemNumber: 42,
                    itemType: 'issue',
                    repositoryId: event.repositoryId,
                    schemaVersion: 1,
                    status: 'briefing',
                    worktreeBranch: assignmentInput.worktree.branch,
                    worktreePath: assignmentInput.worktree.path,
                  },
                },
              ],
              sessionId: 'session-1',
            },
          };
        }
        if (method === 'chat.history') {
          return {
            messages: [
              { messageId: event.id, role: 'user' },
              { id: 'assistant-1', role: 'assistant' },
            ],
            sessionId: 'session-1',
            sessionKey: route.sessionKey,
          };
        }
        return { key: route.sessionKey, ok: true };
      },
      pluginId: 'agent-system',
      recordInboundSession: (async () => undefined) as never,
    });

    const observed = await service.inspect(assignmentInput);

    assert.deepEqual(observed, { id: 'session-1', key: route.sessionKey, status: 'active' });
    assert.deepEqual(
      calls.map(({ method }) => method),
      ['sessions.describe', 'chat.history', 'sessions.pluginPatch'],
    );
    assert.equal((calls[2]?.params?.value as { status?: string } | undefined)?.status, 'active');
  });

  it('should distinguish an in-flight briefing from an incomplete claimed briefing', async () => {
    for (const [hasActiveRun, status] of [
      [true, 'briefing-running'],
      [false, 'incomplete'],
    ] as const) {
      const service = new GitHubNotificationSessionService({
        ...sessionDependencies,
        dispatchReplyWithBufferedBlockDispatcher: (() => undefined) as never,
        async gatewayRequest(method) {
          if (method === 'sessions.describe') {
            return {
              session: {
                archived: false,
                key: route.sessionKey,
                pluginExtensions: [
                  {
                    namespace: 'work-item',
                    pluginId: 'agent-system',
                    value: {
                      assignmentEventId: event.id,
                      itemNumber: 42,
                      itemType: 'issue',
                      repositoryId: event.repositoryId,
                      schemaVersion: 1,
                      status: 'briefing',
                      worktreeBranch: assignmentInput.worktree.branch,
                      worktreePath: assignmentInput.worktree.path,
                    },
                  },
                ],
                sessionId: 'session-1',
              },
            };
          }
          if (method === 'chat.history') {
            return { messages: [{ messageId: event.id, role: 'user' }] };
          }
          if (method === 'sessions.list') {
            return { sessions: [{ hasActiveRun, key: route.sessionKey }] };
          }
          throw new Error(`unexpected gateway method ${method}`);
        },
        pluginId: 'agent-system',
        recordInboundSession: (async () => undefined) as never,
      });

      assert.deepEqual(await service.inspect(assignmentInput), {
        id: 'session-1',
        key: route.sessionKey,
        status,
      });
    }
  });

  it('should dispatch one bounded local no-tools briefing and mark it active', async () => {
    const metadataStatuses: string[] = [];
    const sessionPatches: Array<Record<string, unknown> | undefined> = [];
    let dispatches = 0;
    let records = 0;
    const service = new GitHubNotificationSessionService({
      ...sessionDependencies,
      dispatchReplyWithBufferedBlockDispatcher: (async () => {
        dispatches += 1;
        return {};
      }) as never,
      async gatewayRequest(method, params) {
        if (method === 'sessions.patch') sessionPatches.push(params);
        if (method === 'sessions.pluginPatch') {
          metadataStatuses.push((params?.value as { status: string }).status);
        }
        return { key: route.sessionKey, ok: true };
      },
      pluginId: 'agent-system',
      recordInboundSession: (async () => {
        records += 1;
      }) as never,
    });

    const observed = await service.dispatchBriefing({
      ...assignmentInput,
      delivery: {
        ...assignmentInput.delivery,
        sessionId: 'session-1',
        sessionKey: route.sessionKey,
        stage: 'session-ready',
      },
    });

    assert.equal(records, 1);
    assert.equal(dispatches, 1);
    assert.equal(sessionPatches.length, 1);
    assert.equal(sessionPatches[0]?.sendPolicy, 'deny');
    assert.deepEqual(metadataStatuses, ['briefing', 'active']);
    assert.deepEqual(observed, { id: 'session-1', key: route.sessionKey, status: 'active' });
  });

  it('should reapply outbound denial after partial session preparation', async () => {
    let patchAttempts = 0;
    const service = new GitHubNotificationSessionService({
      ...sessionDependencies,
      dispatchReplyWithBufferedBlockDispatcher: (async () => ({})) as never,
      async gatewayRequest(method, params) {
        if (method === 'sessions.create') {
          return { key: route.sessionKey, ok: true, sessionId: 'session-1' };
        }
        if (method === 'sessions.patch') {
          patchAttempts += 1;
          assert.equal(params?.sendPolicy, 'deny');
          if (patchAttempts === 1) throw new Error('session patch interrupted');
          return { key: route.sessionKey, ok: true };
        }
        if (method === 'sessions.describe') {
          return {
            session: {
              archived: false,
              key: route.sessionKey,
              sessionId: 'session-1',
            },
          };
        }
        if (method === 'chat.history') return { messages: [] };
        return { key: route.sessionKey, ok: true };
      },
      pluginId: 'agent-system',
      recordInboundSession: (async () => undefined) as never,
    });

    await assert.rejects(service.prepare(assignmentInput), /session patch interrupted/u);
    assert.deepEqual(await service.inspect(assignmentInput), {
      id: 'session-1',
      key: route.sessionKey,
      status: 'ready',
    });
    await service.dispatchBriefing({
      ...assignmentInput,
      delivery: {
        ...assignmentInput.delivery,
        sessionId: 'session-1',
        sessionKey: route.sessionKey,
        stage: 'session-ready',
      },
    });

    assert.equal(patchAttempts, 2);
  });

  it('should prepare a local-only no-tools turn in the managed worktree', async () => {
    const gatewayCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const service = new GitHubNotificationSessionService({
      ...sessionDependencies,
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
      ...sessionDependencies,
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
      ...sessionDependencies,
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

  it('should mark, abort, and archive a retired session without deleting it', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const service = new GitHubNotificationSessionService({
      ...sessionDependencies,
      dispatchReplyWithBufferedBlockDispatcher: (() => undefined) as never,
      async gatewayRequest(method, params) {
        calls.push({ method, params });
        if (method === 'sessions.abort') {
          return { abortedRunId: 'run-1', ok: true, status: 'aborted' };
        }
        return { key: route.sessionKey, ok: true };
      },
      pluginId: 'agent-system',
      readConfig: () => ({ ...config, bindings: [] }),
      recordInboundSession: (async () => undefined) as never,
    });

    const result = await service.retire({
      ...assignmentInput,
      delivery: {
        ...assignmentInput.delivery,
        sessionId: 'session-1',
        sessionKey: route.sessionKey,
        stage: 'active',
        worktreeBranch: assignmentInput.worktree.branch,
        worktreePath: assignmentInput.worktree.path,
      },
    });

    assert.deepEqual(result, { id: 'session-1', key: route.sessionKey, status: 'retired' });
    assert.deepEqual(calls, [
      {
        method: 'sessions.abort',
        params: { agentId: 'data', key: route.sessionKey },
      },
      {
        method: 'sessions.pluginPatch',
        params: {
          key: route.sessionKey,
          namespace: 'work-item',
          pluginId: 'agent-system',
          value: {
            assignmentEventId: event.id,
            itemNumber: 42,
            itemType: 'issue',
            repositoryId: event.repositoryId,
            schemaVersion: 1,
            status: 'retired',
            worktreeBranch: assignmentInput.worktree.branch,
            worktreePath: assignmentInput.worktree.path,
          },
        },
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
