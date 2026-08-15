import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import GitHubNotificationCapabilityRegistry from '../channels/github/capabilities/registry.ts';
import GitHubNotificationCommentTurnService, {
  GitHubNotificationCommentTurnError,
  type GitHubNotificationCommentTurnServiceDependencies,
} from '../channels/github/lib/comment-turn-service.ts';
import {
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
} from '../channels/github/utils/comment-admission.ts';
import { githubNotificationChannelId } from '../channels/github/utils/routing.ts';
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

describe('channels/github/lib/comment-turn-service', () => {
  it('should dispatch the exact comment in the existing session and retain one public reply', async () => {
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
      capabilities: new GitHubNotificationCapabilityRegistry(),
      async dispatchReplyWithBufferedBlockDispatcher(input) {
        assert.equal(recorded, true);
        assert.equal(createIfMissing, false);
        assert.equal(input.ctx.Body, comment.body);
        assert.equal(input.ctx.BodyForAgent, comment.body);
        assert.equal(input.ctx.RawBody, comment.body);
        assert.equal(input.ctx.Provider, githubNotificationChannelId);
        assert.equal(input.replyOptions?.disableTools, false);
        assert.equal(input.replyOptions?.runId, undefined);
        assert.equal(input.replyOptions?.sourceReplyDeliveryMode, 'automatic');
        assert.equal(input.toolsAllow, undefined);
        assert.doesNotMatch(String(input.ctx.BodyForAgent), /Return exactly/u);
        await input.dispatcherOptions.deliver(
          {
            text: [
              '## 💬 Comment answered',
              '',
              'The request was answered.',
              '',
              '## Response',
              '',
              'Ready.',
              '',
              '## 📤 To GitHub',
              '',
              '> ready',
            ].join('\n'),
          },
          { kind: 'final' },
        );
        return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false };
      },
      logger: { error() {}, info() {}, warn() {} },
      readConfig: async () => config,
      recordInboundSession,
    });

    const result = await service.respond({
      agentId,
      comment,
      item,
      revision,
      workspaceDir,
    });

    assert.equal(result.publicText, 'ready');
    assert.equal(result.accountId, agentId);
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
      capabilities: new GitHubNotificationCapabilityRegistry(),
      async dispatchReplyWithBufferedBlockDispatcher() {
        throw new Error('unexpected model dispatch');
      },
      logger: { error() {}, info() {}, warn() {} },
      readConfig: async () => config,
      async recordInboundSession(input) {
        input.trackSessionMetaTask?.(Promise.resolve(null));
      },
    });

    await assert.rejects(
      service.respond({
        agentId,
        comment,
        item,
        revision: githubCommentRevision(comment),
        workspaceDir,
      }),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentTurnError &&
        error.code === 'github-notification-comment-session-missing',
    );
  });
});
