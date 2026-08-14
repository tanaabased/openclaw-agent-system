import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { GitHubNotificationAssignmentEvent } from '../channels/github/channel.ts';
import GitHubNotificationSessionService, {
  type GitHubNotificationSessionServiceDependencies,
} from '../channels/github/lib/session-service.ts';
import { resolveNotificationRoute } from '../channels/github/utils/routing.ts';

type InboundSessionRecord = Parameters<
  GitHubNotificationSessionServiceDependencies['recordInboundSession']
>[0];

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
  overrides: {
    config?: OpenClawConfig;
    dispatch?: GitHubNotificationSessionServiceDependencies['dispatchReplyWithBufferedBlockDispatcher'];
    publish?: GitHubNotificationSessionServiceDependencies['publicationService']['publish'];
    record?: (params: InboundSessionRecord) => void | Promise<void>;
    recordTask?: Promise<void>;
  } = {},
): GitHubNotificationSessionService {
  const recordInboundSession: GitHubNotificationSessionServiceDependencies['recordInboundSession'] =
    async (params) => {
      const recordTask = (overrides.recordTask ?? Promise.resolve())
        .then(() => overrides.record?.(params))
        .catch(params.onRecordError);
      params.trackSessionMetaTask?.(recordTask);
    };
  return new GitHubNotificationSessionService({
    dispatchReplyWithBufferedBlockDispatcher:
      overrides.dispatch ?? (async () => ({ counts: {} }) as never),
    logger: { error() {}, info() {}, warn() {} },
    publicationService: {
      publish:
        overrides.publish ??
        (async () => ({ reason: 'non_final', status: 'not_applicable' as const })),
    },
    readConfig: () => overrides.config ?? config,
    recordInboundSession,
  });
}

describe('channels/github/lib/session-service', () => {
  it('should await the routed session record without dispatching an agent turn', async () => {
    let completeRecord: (() => void) | undefined;
    const recordTask = new Promise<void>((resolveRecord) => {
      completeRecord = resolveRecord;
    });
    let records = 0;
    let recordedContext: InboundSessionRecord['ctx'] | undefined;
    const service = createService({
      record: ({ ctx }) => {
        records += 1;
        recordedContext = ctx;
      },
      recordTask,
    });

    let settled = false;
    const pending = service.recordSession(assignmentInput).then((observed) => {
      settled = true;
      return observed;
    });
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));

    assert.equal(settled, false);
    completeRecord?.();
    const observed = await pending;

    assert.equal(records, 1);
    assert.equal(
      recordedContext?.ConversationLabel,
      'tanaabased/openclaw-agent-system#42 · agent/data/github-42',
    );
    assert.deepEqual(observed, { key: route.sessionKey, status: 'active' });
  });

  it('should propagate notification session record failures', async () => {
    const service = createService({
      record: () => {
        throw new Error('session record failed');
      },
    });

    await assert.rejects(service.recordSession(assignmentInput), /session record failed/u);
  });

  it('should run one tool-free private plan before publishing its safe acknowledgment', async () => {
    let adopted = 0;
    let published: Record<string, unknown> | undefined;
    const service = createService({
      async dispatch(input) {
        assert.equal(input.ctx.Provider, 'agent-system-github');
        assert.equal(input.ctx.Surface, 'agent-system-github');
        assert.equal(input.ctx.OriginatingChannel, 'agent-system-github');
        assert.equal(input.replyOptions?.disableTools, true);
        assert.equal(input.replyOptions?.commentaryPayloadsEnabled, true);
        assert.equal(input.replyOptions?.sourceReplyDeliveryMode, 'automatic');
        assert.deepEqual(input.toolsAllow, []);
        assert.match(String(input.ctx.BodyForAgent), /private, plan-only first pass/u);
        await input.replyOptions?.onTurnAdopted?.();
        await input.dispatcherOptions.deliver(
          {
            isCommentary: true,
            text: [
              'ACKNOWLEDGMENT: I have read this through and mapped out a plan.',
              'ASSESSMENT:',
              'The request is bounded.',
              'BLOCKERS:',
              'None.',
              'PLAN:',
              '1. Implement it.',
            ].join('\n'),
          },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
      async publish(input) {
        published = input as unknown as Record<string, unknown>;
        return {
          delivery: { messageIds: ['91'], visibleReplySent: true },
          status: 'handled_visible',
        };
      },
    });
    const delivery = {
      ...assignmentInput.delivery,
      acknowledgment: { status: 'pending' as const },
      activation: { status: 'pending' as const },
      sessionKey: route.sessionKey,
      stage: 'active' as const,
    };

    const result = await service.planAssignment({
      ...assignmentInput,
      context: {
        body: 'Please implement the behavior.',
        comments: [],
        labels: ['feature'],
        title: 'Implement the behavior',
        truncated: false,
      },
      delivery,
      async onTurnAdopted() {
        adopted += 1;
      },
    });

    assert.equal(adopted, 1);
    assert.deepEqual(result, { acknowledgmentCommentId: 91 });
    assert.equal(published?.intent, 'initial-acknowledgment');
    assert.deepEqual(published?.payload, {
      text: 'I have read this through and mapped out a plan.',
    });
  });

  it('should preserve planning completion when the public candidate is missing', async () => {
    let publications = 0;
    const service = createService({
      async dispatch(input) {
        await input.replyOptions?.onTurnAdopted?.();
        await input.dispatcherOptions.deliver(
          { text: 'ASSESSMENT:\nReady.\nBLOCKERS:\nNone.\nPLAN:\n1. Implement it.' },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
      async publish() {
        publications += 1;
        return { reason: 'non_final', status: 'not_applicable' };
      },
    });

    const result = await service.planAssignment({
      ...assignmentInput,
      context: {
        body: '',
        comments: [],
        labels: [],
        title: 'Implement the behavior',
        truncated: false,
      },
      onTurnAdopted: () => undefined,
    });

    assert.deepEqual(result, {
      acknowledgmentFailureCode: 'github-notification-planning-acknowledgment-missing',
    });
    assert.equal(publications, 0);
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
    assert.equal(turn.ctxPayload.ConversationLabel, 'tanaabased/openclaw-agent-system#42');
    assert.equal(turn.ctxPayload.InboundEventKind, 'user_request');
    assert.equal(turn.ctxPayload.BodyForAgent, 'GitHub issue #42 was assigned to this agent.');
    assert.equal(turn.ctxPayload.Provider, 'agent-system-github');
    assert.equal(turn.ctxPayload.Surface, 'agent-system-github');
    assert.equal(turn.ctxPayload.OriginatingChannel, 'agent-system-github');
    const context = turn.ctxPayload as unknown as Record<string, unknown>;
    assert.equal(context.githubItemNumber, event.itemNumber);
    assert.equal(context.githubItemType, event.itemType);
    assert.equal(context.githubRepositoryId, event.repositoryId);
    assert.equal(context.githubWorktreeBranch, assignmentInput.worktree.branch);
    assert.equal(context.githubWorktreePath, assignmentInput.worktree.path);
    assert.equal(turn.record?.createIfMissing, true);
    assert.equal(typeof turn.record?.onRecordError, 'function');
    assert.equal(typeof turn.record?.trackSessionMetaTask, 'function');
    assert.equal(typeof turn.afterRecord, 'function');
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
