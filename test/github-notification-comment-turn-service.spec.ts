import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import GitHubNotificationTurnContractResolver from '../channels/github/conversation/turn-contract.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import GitHubNotificationModeRegistry from '../channels/github/modes/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import GitHubNotificationCommentTurnService, {
  GitHubNotificationCommentTurnError,
  type GitHubNotificationCommentTurnServiceDependencies,
} from '../channels/github/conversation/comment-turn-service.ts';
import {
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
} from '../channels/github/conversation/comment-admission.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import {
  notificationActor,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';
const config: OpenClawConfig = {
  agents: {
    list: [{ id: agentId, tools: { profile: 'coding' }, workspace: workspaceDir }],
  },
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

function turnContracts() {
  const lifecycle = new GitHubIssueLifecycle({
    async inspectGitHub() {
      return undefined;
    },
    async prepareGitHub() {
      throw new Error('not used');
    },
  });
  return new GitHubNotificationTurnContractResolver({
    lifecycles: new GitHubNotificationLifecycleRegistry([lifecycle]),
    modes: new GitHubNotificationModeRegistry([githubNotificationWorkMode]),
  });
}

function incomingComment(): GitHubCanonicalIssueComment {
  return {
    author: notificationActor,
    body: '@tanaabot reply with ready',
    bodyTruncated: false,
    createdAt: '2026-08-15T12:00:00.000Z',
    databaseId: 91,
    nodeId: 'IC_comment',
    updatedAt: '2026-08-15T12:00:00.000Z',
  };
}

function candidateStore(candidates: readonly string[]) {
  let identity:
    { agentId: string; conversationId: string; revisionId: string; turnId?: string } | undefined;
  return {
    async begin(input: { agentId: string; conversationId: string; revisionId: string }) {
      identity = { ...input };
      return 'turn-1';
    },
    async cancel(input: {
      agentId: string;
      conversationId: string;
      revisionId: string;
      turnId: string;
    }) {
      assert.deepEqual(input, { ...identity, turnId: 'turn-1' });
    },
    async finish(input: {
      agentId: string;
      conversationId: string;
      revisionId: string;
      turnId: string;
    }) {
      assert.deepEqual(input, { ...identity, turnId: 'turn-1' });
      return [...candidates];
    },
  };
}

async function respondWithCandidates(
  candidates: readonly string[],
  executionSurface: 'cli-one-shot' | 'gateway' = 'gateway',
  inspectReplyOptions?: (options: Record<string, unknown>) => void,
) {
  const item = notificationMonitorState().items[notificationItemKey]!;
  item.intake = {
    ...item.intake!,
    stage: 'prepared',
    worktreeBranch: 'issue-12',
    worktreePath: '/workspace/worktrees/issue-12',
  };
  const comment = incomingComment();
  const service = new GitHubNotificationCommentTurnService({
    candidates: candidateStore(candidates),
    async dispatchReplyWithBufferedBlockDispatcher(input) {
      inspectReplyOptions?.(input.replyOptions ?? {});
      await input.dispatcherOptions.deliver(
        { text: 'Private response remains available.' },
        {
          kind: 'final',
        },
      );
      return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
    },
    logger: { error() {}, info() {}, warn() {} },
    readConfig: async () => config,
    async recordInboundSession(input) {
      input.trackSessionMetaTask?.(Promise.resolve({ sessionId: 'session-1' }));
    },
    turnContracts: turnContracts(),
  });
  return service.respond({
    agentId,
    comment,
    executionSurface,
    item,
    modeId: 'work',
    revision: githubCommentRevision(comment),
    workspaceDir,
  });
}

describe('channels/github/conversation/comment-turn-service', () => {
  it('should dispatch the exact comment and retain one ordinary private response', async () => {
    const item = notificationMonitorState().items[notificationItemKey]!;
    item.intake = {
      ...item.intake!,
      stage: 'prepared',
      worktreeBranch: 'issue-12',
      worktreePath: '/workspace/worktrees/issue-12',
    };
    const comment = incomingComment();
    const revision = githubCommentRevision(comment);
    let createIfMissing: boolean | undefined;
    let recorded = false;
    const recordInboundSession: GitHubNotificationCommentTurnServiceDependencies['recordInboundSession'] =
      async (input) => {
        createIfMissing = input.createIfMissing;
        const task = Promise.resolve().then(() => {
          recorded = true;
          return { sessionId: 'session-1' };
        });
        input.trackSessionMetaTask?.(task);
      };
    const service = new GitHubNotificationCommentTurnService({
      candidates: candidateStore(['ready']),
      async dispatchReplyWithBufferedBlockDispatcher(input) {
        assert.equal(recorded, true);
        assert.equal(createIfMissing, false);
        assert.equal(input.ctx.Body, comment.body);
        assert.equal(input.ctx.BodyForAgent, comment.body);
        assert.equal(input.ctx.RawBody, comment.body);
        assert.equal(input.ctx.Provider, githubNotificationChannelId);
        assert.equal(input.replyOptions?.disableTools, false);
        const replyOptions = input.replyOptions as Record<string, unknown>;
        assert.equal(replyOptions.cleanupBundleMcpOnRunEnd, true);
        assert.equal(replyOptions.cleanupCliLiveSessionOnRunEnd, true);
        assert.equal(replyOptions.oneShotCliRun, true);
        assert.equal(input.replyOptions?.runId, undefined);
        assert.equal(input.replyOptions?.sourceReplyDeliveryMode, 'automatic');
        assert.equal(input.toolsAllow, undefined);
        assert.doesNotMatch(String(input.ctx.BodyForAgent), /Return exactly/u);
        await input.dispatcherOptions.deliver(
          {
            text: [
              'I checked the request and it is ready.',
              '',
              '## Notes',
              'This private response may use normal Markdown without a publication envelope.',
            ].join('\n'),
          },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
      logger: { error() {}, info() {}, warn() {} },
      readConfig: async () => config,
      recordInboundSession,
      turnContracts: turnContracts(),
    });

    const result = await service.respond({
      agentId,
      comment,
      executionSurface: 'cli-one-shot',
      item,
      modeId: 'work',
      revision,
      workspaceDir,
    });

    assert.equal(
      result.privateText,
      'I checked the request and it is ready.\n\n## Notes\nThis private response may use normal Markdown without a publication envelope.',
    );
    assert.deepEqual(result.publication, { status: 'candidate', publicText: 'ready' });
    assert.equal(result.accountId, agentId);
    assert.deepEqual((result.ctxPayload.ChannelContext as Record<string, unknown>).chat, {
      githubNotificationTurn: {
        eventId: 'comment',
        lifecycleId: 'issue',
        modeId: 'work',
      },
      id: 'github:issue:R_repo:12',
    });
    assert.deepEqual(result.ctxPayload.UntrustedStructuredContext, [
      {
        comment: {
          databaseId: 91,
          nodeId: 'IC_comment',
          revisionId: revision.revisionId,
        },
        item: {
          lifecycleId: 'issue',
          number: 12,
          repositoryName: 'example',
          repositoryOwner: 'tanaabased',
        },
        worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
      },
    ]);
    assert.equal(
      JSON.stringify(result.ctxPayload.UntrustedStructuredContext),
      `[{"comment":{"databaseId":91,"nodeId":"IC_comment","revisionId":"${revision.revisionId}"},"item":{"lifecycleId":"issue","number":12,"repositoryName":"example","repositoryOwner":"tanaabased"},"worktree":{"branch":"issue-12","path":"/workspace/worktrees/issue-12"}}]`,
    );
  });

  it('should reject a comment turn when the assignment session is absent', async () => {
    const item = notificationMonitorState().items[notificationItemKey]!;
    item.intake = {
      ...item.intake!,
      stage: 'prepared',
      worktreeBranch: 'issue-12',
      worktreePath: '/workspace/worktrees/issue-12',
    };
    const comment = incomingComment();
    const service = new GitHubNotificationCommentTurnService({
      candidates: candidateStore([]),
      async dispatchReplyWithBufferedBlockDispatcher() {
        throw new Error('unexpected model dispatch');
      },
      logger: { error() {}, info() {}, warn() {} },
      readConfig: async () => config,
      async recordInboundSession(input) {
        input.trackSessionMetaTask?.(Promise.resolve(null));
      },
      turnContracts: turnContracts(),
    });

    await assert.rejects(
      service.respond({
        agentId,
        comment,
        executionSurface: 'gateway',
        item,
        modeId: 'work',
        revision: githubCommentRevision(comment),
        workspaceDir,
      }),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentTurnError &&
        error.code === 'github-notification-comment-session-missing',
    );
  });

  it('should preserve the private response when the typed candidate is missing', async () => {
    const result = await respondWithCandidates([]);

    assert.equal(result.privateText, 'Private response remains available.');
    assert.deepEqual(result.publication, {
      status: 'withheld',
      code: 'github-notification-publication-candidate-missing',
    });
  });

  it('should preserve long-lived host resources for gateway turns', async () => {
    let replyOptions: Record<string, unknown> = {};

    await respondWithCandidates(['ready'], 'gateway', (options) => {
      replyOptions = options;
    });

    assert.equal(replyOptions.oneShotCliRun, undefined);
    assert.equal(replyOptions.cleanupBundleMcpOnRunEnd, undefined);
    assert.equal(replyOptions.cleanupCliLiveSessionOnRunEnd, undefined);
  });

  it('should withhold publication when more than one typed candidate is returned', async () => {
    const result = await respondWithCandidates(['first', 'second']);

    assert.deepEqual(result.publication, {
      status: 'withheld',
      code: 'github-notification-publication-candidate-duplicate',
    });
  });

  it('should withhold a typed candidate that fails deterministic safety validation', async () => {
    const result = await respondWithCandidates(['See @pirog for a secret.']);

    assert.deepEqual(result.publication, {
      status: 'withheld',
      code: 'github-notification-publication-secret-safety-rejected',
    });
  });
});
