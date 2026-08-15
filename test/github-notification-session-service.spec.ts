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
    promptInstructions?: GitHubNotificationSessionServiceDependencies['promptInstructions'];
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
    promptInstructions: overrides.promptInstructions ?? {
      prepare: () => ({ adopt() {}, clear() {}, runId: 'notification-run' }),
    },
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
  it('should run one tool-free private plan and publish only its quoted github outcome', async () => {
    let adopted = 0;
    let acknowledged = 0;
    let completed = 0;
    let instructionAdopted = 0;
    let instructionRequest: unknown;
    let published: Record<string, unknown> | undefined;
    const publicationIntents: string[] = [];
    const service = createService({
      async dispatch(input) {
        assert.equal(input.ctx.AccountId, 'data');
        assert.equal(input.ctx.Provider, 'agent-system-github');
        assert.equal(input.ctx.Surface, 'agent-system-github');
        assert.equal(input.ctx.OriginatingChannel, 'agent-system-github');
        assert.equal(input.replyOptions?.disableTools, true);
        assert.equal(input.replyOptions?.commentaryPayloadsEnabled, true);
        assert.equal(input.replyOptions?.runId, 'planning-run');
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
        assert.deepEqual(input.ctx.ChannelContext?.chat, { id: route.conversationId });
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
        assert.equal(instructionAdopted, 1);
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
              '',
              '## 📤 To GitHub',
              '',
              '> I reviewed the assignment and have a plan ready.',
            ].join('\n'),
          },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
      promptInstructions: {
        prepare(request) {
          instructionRequest = request;
          return {
            adopt() {
              instructionAdopted += 1;
            },
            clear() {
              assert.fail('successful dispatch should retain instructions until run cleanup');
            },
            runId: 'planning-run',
          };
        },
      },
      async publish(input) {
        publicationIntents.push(input.intent);
        if (input.intent === 'initial-acknowledgment') {
          assert.deepEqual(input.payload, {
            text: 'I received this assignment and started planning it.',
          });
        }
        published = input as unknown as Record<string, unknown>;
        return {
          delivery: { messageIds: ['91'], visibleReplySent: true },
          status: 'handled_visible',
        };
      },
      record: (params) => {
        assert.equal(params.createIfMissing, true);
      },
    });
    const delivery = {
      ...assignmentInput.delivery,
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
      async onAcknowledgmentCompleted(acknowledgment) {
        acknowledged += 1;
        assert.deepEqual(acknowledgment, { commentId: 91, status: 'published' });
      },
      async onPlanningCompleted() {
        completed += 1;
      },
      async onTurnAdopted(session) {
        adopted += 1;
        assert.deepEqual(session, {
          key: route.sessionKey,
          mode: 'plan',
          status: 'received',
        });
      },
    });

    assert.equal(adopted, 1);
    assert.equal(acknowledged, 1);
    assert.equal(completed, 1);
    assert.deepEqual(instructionRequest, {
      assignmentKind: 'issue',
      event: 'planning-request',
      mode: 'plan',
    });
    assert.deepEqual(publicationIntents, ['initial-acknowledgment', 'planning-outcome']);
    assert.deepEqual(result, {
      reply: { commentId: 91, status: 'published' },
      status: 'planned',
    });
    assert.equal(published?.intent, 'planning-outcome');
    assert.deepEqual(published?.payload, {
      text: 'I reviewed the assignment and have a plan ready.',
    });
  });

  it('should clear adopted prompt instructions when planning dispatch fails', async () => {
    let cleared = 0;
    const service = createService({
      async dispatch(input) {
        await input.replyOptions?.onTurnAdopted?.();
        throw new Error('notification dispatch failed');
      },
      promptInstructions: {
        prepare() {
          return {
            adopt() {},
            clear() {
              cleared += 1;
            },
            runId: 'failed-planning-run',
          };
        },
      },
    });

    await assert.rejects(
      service.planAssignment({
        ...assignmentInput,
        context: {
          body: 'Please implement the behavior.',
          comments: [],
          labels: ['feature'],
          title: 'Implement the behavior',
          truncated: false,
        },
        delivery: {
          ...assignmentInput.delivery,
          activation: { status: 'pending' },
          sessionKey: route.sessionKey,
          stage: 'active',
        },
        onAcknowledgmentCompleted: () => undefined,
        onPlanningCompleted: () => undefined,
        onTurnAdopted: () => undefined,
      }),
      /notification dispatch failed/u,
    );
    assert.equal(cleared, 1);
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
        assert.deepEqual(input.ctx.ChannelContext?.chat, { id: route.conversationId });
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
              '',
              '## 📤 To GitHub',
              '',
              '> I reviewed the pull request and have a recommended next action.',
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
        activation: { status: 'pending' as const },
        sessionKey: route.sessionKey,
        stage: 'active' as const,
      },
      onAcknowledgmentCompleted: () => undefined,
      onPlanningCompleted: () => undefined,
      onTurnAdopted: () => undefined,
    });

    assert.deepEqual(result, {
      reply: { commentId: 91, status: 'published' },
      status: 'planned',
    });
  });

  it('should retain a valid private plan when its public outcome is invalid', async () => {
    let completed = 0;
    let publications = 0;
    const service = createService({
      async dispatch(input) {
        await input.replyOptions?.onTurnAdopted?.();
        await input.dispatcherOptions.deliver(
          {
            text: [
              '## Assessment',
              '',
              'The assignment is bounded.',
              '',
              '## Blockers',
              '',
              'None.',
              '',
              '## Plan',
              '',
              '1. Implement the contract.',
            ].join('\n'),
          },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
      async publish(input) {
        publications += 1;
        assert.equal(input.intent, 'initial-acknowledgment');
        return {
          delivery: { messageIds: ['91'], visibleReplySent: true },
          status: 'handled_visible',
        };
      },
    });

    const result = await service.planAssignment({
      ...assignmentInput,
      context: {
        body: 'Please implement the behavior.',
        comments: [],
        labels: ['feature'],
        title: 'Implement the behavior',
        truncated: false,
      },
      delivery: {
        ...assignmentInput.delivery,
        activation: { status: 'pending' },
        sessionKey: route.sessionKey,
        stage: 'active',
      },
      onAcknowledgmentCompleted: () => undefined,
      async onPlanningCompleted() {
        completed += 1;
      },
      onTurnAdopted: () => undefined,
    });

    assert.equal(completed, 1);
    assert.equal(publications, 1);
    assert.deepEqual(result, {
      reply: {
        failureCode: 'github-notification-planning-reply-invalid',
        status: 'failed',
      },
      status: 'planned',
    });
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
        assert.equal(input.ctx.AccountId, 'data');
        assert.equal(input.ctx.Provider, 'agent-system-github');
        assert.equal(input.replyOptions?.disableTools, true);
        assert.deepEqual(input.toolsAllow, []);
        assert.equal(input.ctx.SenderId, 'U_actor');
        assert.equal(input.ctx.Body, context.body);
        assert.equal(input.ctx.RawBody, context.body);
        assert.equal(input.ctx.BodyForAgent, context.body);
        assert.equal(input.replyOptions?.runId, 'notification-run');
        assert.deepEqual(input.ctx.ChannelContext?.chat, { id: route.conversationId });
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
                assignmentActive: true,
                planningReplyStatus: 'published',
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
      activation: {
        reply: { commentId: 91, status: 'published' as const },
        status: 'planned' as const,
      },
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
});
