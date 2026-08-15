import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { GitHubNotificationAssignmentEvent } from '../channels/github/channel.ts';
import GitHubNotificationSessionService, {
  type GitHubNotificationSessionServiceDependencies,
} from '../channels/github/lib/session-service.ts';
import { resolveNotificationRoute } from '../channels/github/utils/routing.ts';
import { githubCommentRevision } from '../channels/github/utils/comment-admission.ts';

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
const pullRequest = {
  baseRef: 'main',
  draft: false,
  headRef: 'notification-pr',
  headSha: 'a'.repeat(40),
};
const assignmentInput = {
  agentId: 'data',
  delivery: {
    assignmentEventId: event.id,
    mode: 'plan' as const,
    schemaVersion: 1 as const,
    stage: 'worktree-ready' as const,
    workId: 'issue-42',
    worktreeBranch: 'agent/data/github-42',
    worktreePath: '/workspace/data/.agent-system/worktrees/github-42',
  },
  item: {
    assignmentActorLogin: 'pirog',
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
const pullRequestAssignmentInput = {
  agentId: assignmentInput.agentId,
  delivery: {
    assignmentEventId: assignmentInput.delivery.assignmentEventId,
    mode: 'plan' as const,
    schemaVersion: 1 as const,
    stage: 'session-recording' as const,
    workId: 'pull-request-42',
  },
  item: {
    ...assignmentInput.item,
    itemType: 'pull-request' as const,
    pullRequest,
  },
  workspaceDir: assignmentInput.workspaceDir,
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
        (async () => ({
          delivery: { messageIds: ['91'], visibleReplySent: true },
          status: 'handled_visible' as const,
        })),
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
    let published: Record<string, unknown> | undefined;
    const service = createService({
      async publish(input) {
        published = input as unknown as Record<string, unknown>;
        return {
          delivery: { messageIds: ['91'], visibleReplySent: true },
          status: 'handled_visible',
        };
      },
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
    assert.equal(published, undefined);
    completeRecord?.();
    const observed = await pending;

    assert.equal(records, 1);
    assert.equal(
      recordedContext?.ConversationLabel,
      'tanaabased/openclaw-agent-system#42 · agent/data/github-42',
    );
    assert.equal(
      recordedContext?.BodyForAgent,
      [
        '## 📥 Issue assignment received',
        '',
        '[@pirog](https://github.com/pirog) assigned you [tanaabased/openclaw-agent-system#42](https://github.com/tanaabased/openclaw-agent-system/issues/42).',
        '',
        '**Mode:** Plan — investigate the issue and prepare an implementation plan.',
      ].join('\n'),
    );
    assert.deepEqual(observed, {
      acknowledgment: { commentId: 91, status: 'published' },
      key: route.sessionKey,
      mode: 'plan',
      status: 'active',
    });
    const publication = published as Record<string, unknown> | undefined;
    assert.ok(publication);
    assert.equal(publication.intent, 'initial-acknowledgment');
    assert.deepEqual(publication.payload, {
      text: 'Got it — I received this issue assignment and I am preparing an implementation plan.',
    });
  });

  it('should propagate notification session record failures', async () => {
    const service = createService({
      record: () => {
        throw new Error('session record failed');
      },
    });

    await assert.rejects(service.recordSession(assignmentInput), /session record failed/u);
  });

  it('should label a pull-request session by its observed head without a worktree', async () => {
    let recordedContext: InboundSessionRecord['ctx'] | undefined;
    const service = createService({
      record: ({ ctx }) => {
        recordedContext = ctx;
      },
    });
    const observed = await service.recordSession(pullRequestAssignmentInput);

    assert.equal(
      recordedContext?.ConversationLabel,
      'tanaabased/openclaw-agent-system#42 · head@aaaaaaaaaaaa',
    );
    assert.equal(
      recordedContext?.BodyForAgent,
      [
        '## 🔀 Pull request assignment received',
        '',
        '[@pirog](https://github.com/pirog) assigned you [tanaabased/openclaw-agent-system#42](https://github.com/tanaabased/openclaw-agent-system/pull/42).',
        '',
        '**Mode:** Plan — assess the pull request and prepare a recommended course of action.',
      ].join('\n'),
    );
    const context = recordedContext as unknown as Record<string, unknown>;
    assert.equal(context.githubPullRequestHeadSha, pullRequest.headSha);
    assert.equal(context.githubWorktreePath, undefined);
    assert.deepEqual(observed, {
      acknowledgment: { commentId: 91, status: 'published' },
      key: route.sessionKey,
      mode: 'plan',
      status: 'active',
    });
  });

  it('should run one tool-free private plan with hidden instructions', async () => {
    let adopted = 0;
    const service = createService({
      async dispatch(input) {
        assert.equal(input.ctx.Provider, 'agent-system-github');
        assert.equal(input.ctx.Surface, 'agent-system-github');
        assert.equal(input.ctx.OriginatingChannel, 'agent-system-github');
        assert.equal(input.replyOptions?.disableTools, true);
        assert.equal(input.replyOptions?.commentaryPayloadsEnabled, true);
        assert.equal(input.replyOptions?.sourceReplyDeliveryMode, 'automatic');
        assert.deepEqual(input.toolsAllow, []);
        assert.match(String(input.ctx.BodyForAgent), /^## 📥 Issue assignment received$/mu);
        assert.match(String(input.ctx.BodyForAgent), /@pirog/u);
        assert.match(
          String(input.ctx.BodyForAgent),
          /https:\/\/github\.com\/tanaabased\/openclaw-agent-system\/issues\/42/u,
        );
        assert.match(String(input.ctx.BodyForAgent), /\*\*Mode:\*\* Plan/u);
        assert.doesNotMatch(String(input.ctx.BodyForAgent), /## Assessment/u);
        assert.doesNotMatch(String(input.ctx.BodyForAgent), /untrusted project data/u);
        assert.doesNotMatch(String(input.ctx.BodyForAgent), /Please implement the behavior/u);
        assert.doesNotMatch(String(input.ctx.BodyForAgent), /\/workspace\/data/u);
        assert.deepEqual(input.ctx.ChannelContext?.agentSystemGitHubNotification, {
          assignmentKind: 'issue',
          event: 'planning-request',
          mode: 'plan',
        });
        assert.deepEqual(input.ctx.UntrustedStructuredContext, [
          {
            label: 'GitHub issue context',
            payload: {
              body: 'Please implement the behavior.',
              comments: [],
              labels: ['feature'],
              title: 'Implement the behavior',
              truncated: false,
            },
            source: 'https://github.com/tanaabased/openclaw-agent-system/issues/42',
            type: 'github_issue',
          },
        ]);
        await input.replyOptions?.onTurnAdopted?.();
        await input.dispatcherOptions.deliver(
          {
            isCommentary: true,
            text: [
              '## Assessment',
              '',
              'The request is bounded.',
              '',
              '## Blockers',
              '',
              'None.',
              '',
              '## Plan',
              '',
              '1. Implement it.',
            ].join('\n'),
          },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
    });
    const delivery = {
      ...assignmentInput.delivery,
      acknowledgment: { commentId: 91, status: 'published' as const },
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
    assert.deepEqual(result, { status: 'planned' });
  });

  it('should plan a direct pull request from observed head context without a worktree', async () => {
    const planningContext = {
      body: 'Please review the assigned change.',
      comments: [],
      files: [
        {
          additions: 4,
          changes: 5,
          deletions: 1,
          filename: 'channels/github/lib/session-service.ts',
          status: 'modified',
        },
      ],
      labels: ['review'],
      title: 'Review the notification session',
      truncated: false,
    };
    const service = createService({
      async dispatch(input) {
        const context = input.ctx as unknown as Record<string, unknown>;
        assert.equal(context.githubPullRequestHeadRef, pullRequest.headRef);
        assert.equal(context.githubPullRequestHeadSha, pullRequest.headSha);
        assert.equal(context.githubWorktreeBranch, undefined);
        assert.equal(context.githubWorktreePath, undefined);
        assert.match(String(input.ctx.BodyForAgent), /^## 🔀 Pull request assignment received$/mu);
        assert.doesNotMatch(String(input.ctx.BodyForAgent), /stewardship assessment/u);
        assert.deepEqual(input.ctx.ChannelContext?.agentSystemGitHubNotification, {
          assignmentKind: 'pull-request',
          event: 'planning-request',
          mode: 'plan',
        });
        assert.deepEqual(context.UntrustedStructuredContext, [
          {
            label: 'GitHub pull-request context',
            payload: {
              ...planningContext,
              pullRequest: {
                baseRef: pullRequest.baseRef,
                draft: pullRequest.draft,
                headRef: pullRequest.headRef,
                headSha: pullRequest.headSha,
              },
            },
            source: 'https://github.com/tanaabased/openclaw-agent-system/pull/42',
            type: 'github_pull_request',
          },
        ]);
        await input.replyOptions?.onTurnAdopted?.();
        await input.dispatcherOptions.deliver(
          {
            text: [
              '## Assessment',
              '',
              'The assigned head is ready for monitoring.',
              '',
              '## Blockers',
              '',
              'None.',
              '',
              '## Plan',
              '',
              '1. Monitor discussion and merge readiness.',
            ].join('\n'),
          },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
    });

    const result = await service.planAssignment({
      ...pullRequestAssignmentInput,
      context: planningContext,
      delivery: {
        ...pullRequestAssignmentInput.delivery,
        acknowledgment: { commentId: 91, status: 'published' as const },
        activation: { status: 'pending' as const },
        sessionKey: route.sessionKey,
        stage: 'active' as const,
      },
      onTurnAdopted: () => undefined,
    });

    assert.deepEqual(result, { status: 'planned' });
  });

  it('should run one tool-free rich comment turn and publish only its quoted github reply', async () => {
    const context = {
      author: { login: 'pirog', nodeId: 'U_actor', type: 'User' },
      body: '@data can you share a status update?',
      bodyTruncated: false,
      createdAt: '2026-08-14T12:00:00.000Z',
      databaseId: 92,
      nodeId: 'IC_comment',
      updatedAt: '2026-08-14T12:01:00.000Z',
    };
    const revision = githubCommentRevision(context);
    let published: Record<string, unknown> | undefined;
    let adopted = 0;
    const service = createService({
      async dispatch(input) {
        assert.equal(input.replyOptions?.disableTools, true);
        assert.deepEqual(input.toolsAllow, []);
        assert.equal(input.ctx.SenderId, 'U_actor');
        assert.equal(input.ctx.Body, context.body);
        assert.equal(input.ctx.RawBody, context.body);
        assert.equal(input.ctx.BodyForAgent, context.body);
        assert.deepEqual(input.ctx.ChannelContext?.agentSystemGitHubNotification, {
          assignmentKind: 'issue',
          event: 'comment-received',
          mode: 'plan',
        });
        assert.deepEqual(input.ctx.UntrustedStructuredContext, [
          {
            label: 'GitHub issue comment context',
            payload: {
              bounds: {
                commentBodyCharacters: context.body.length,
                commentBodyTruncated: false,
              },
              comment: context,
              item: {
                itemType: 'issue',
                number: 42,
                repositoryName: 'openclaw-agent-system',
                repositoryOwner: 'tanaabased',
              },
              revision: {
                bodyDigest: revision.bodyDigest,
                id: revision.revisionId,
              },
              statusEvidence: {
                acknowledgmentStatus: 'published',
                assignmentActive: true,
                planningStatus: 'planned',
              },
            },
            source: 'https://github.com/tanaabased/openclaw-agent-system/issues/42#issuecomment-92',
            type: 'github_issue_comment',
          },
        ]);
        await input.replyOptions?.onTurnAdopted?.();
        await input.dispatcherOptions.deliver(
          {
            text: [
              '## 💬 Comment answered',
              '',
              'The recorded assignment evidence supports a bounded status reply.',
              '',
              '## Response',
              '',
              'The assignment is active and the plan is recorded. A local follow-up is required before I can claim fresh repository or test status.',
              '',
              '## 📤 To GitHub',
              '',
              '> I have the plan ready, but I do not have a newly verified implementation update yet.',
            ].join('\n'),
          },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
      async publish(input) {
        published = input as unknown as Record<string, unknown>;
        return {
          delivery: { messageIds: ['93'], visibleReplySent: true },
          status: 'handled_visible',
        };
      },
    });
    const delivery = {
      ...assignmentInput.delivery,
      acknowledgment: { commentId: 91, status: 'published' as const },
      activation: { status: 'planned' as const },
      sessionKey: route.sessionKey,
      stage: 'active' as const,
    };

    const result = await service.respondToComment({
      ...assignmentInput,
      comment: {
        actorNodeId: 'U_actor',
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: context.databaseId,
        commentNodeId: context.nodeId,
        createdAt: Date.parse(context.createdAt),
        disposition: 'approved',
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        turn: { status: 'pending' },
        updatedAt: Date.parse(context.updatedAt),
      },
      context,
      delivery,
      async onTurnAdopted() {
        adopted += 1;
      },
    });

    assert.equal(adopted, 1);
    assert.deepEqual(result, { reply: { commentId: 93, status: 'published' } });
    assert.equal(published?.intent, 'github-reply');
    assert.equal(published?.publicationId, revision.revisionId);
    assert.deepEqual(published?.payload, {
      text: 'I have the plan ready, but I do not have a newly verified implementation update yet.',
    });
  });

  it('should prepare a deterministic observe-only session record', async () => {
    const service = createService();
    const turn = service.prepareTurn({
      config,
      event,
      label: 'tanaabased/openclaw-agent-system#42',
      mode: 'plan',
      route,
      worktree: assignmentInput.worktree,
    });

    assert.equal(turn.channel, 'agent-system-github');
    assert.equal(turn.accountId, 'data');
    assert.equal(turn.routeSessionKey, route.sessionKey);
    assert.equal(turn.ctxPayload.SessionKey, route.sessionKey);
    assert.equal(turn.ctxPayload.ConversationLabel, 'tanaabased/openclaw-agent-system#42');
    assert.equal(turn.ctxPayload.InboundEventKind, 'user_request');
    assert.equal(turn.ctxPayload.BodyForAgent, event.title);
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

  it('should identify a directly assigned pull request in its observe-only session', () => {
    const service = createService();
    const pullRequestEvent = {
      ...event,
      itemType: 'pull-request' as const,
      title: 'GitHub pull request #42 assignment',
    };
    const turn = service.prepareTurn({
      config,
      event: pullRequestEvent,
      label: 'tanaabased/openclaw-agent-system#42',
      mode: 'plan',
      pullRequest,
      route,
    });

    assert.equal(turn.ctxPayload.BodyForAgent, pullRequestEvent.title);
    assert.equal(
      (turn.ctxPayload as unknown as Record<string, unknown>).githubItemType,
      'pull-request',
    );
    const context = turn.ctxPayload as unknown as Record<string, unknown>;
    assert.equal(context.githubPullRequestHeadRef, pullRequest.headRef);
    assert.equal(context.githubPullRequestHeadSha, pullRequest.headSha);
    assert.equal(context.githubWorktreeBranch, undefined);
    assert.equal(context.githubWorktreePath, undefined);
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
          mode: 'plan',
          route,
          worktree: {
            branch: assignmentInput.worktree.branch,
            path: '.agent-system/worktrees/github-42',
          },
        }),
      /worktree paths must be an absolute path/u,
    );
  });
});
