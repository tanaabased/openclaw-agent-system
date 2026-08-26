import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import { githubCommentRevision } from '../channels/github/conversation/comment-admission.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
} from '../channels/github/conversation/conversation-state.ts';
import GitHubNotificationPullRequestHandoffService from '../channels/github/conversation/pull-request-handoff-service.ts';
import githubNotificationPullRequestOpenedEvent from '../channels/github/events/pull-request-opened.ts';
import GitHubNotificationEventRegistry from '../channels/github/events/registry.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import {
  notificationAccount,
  notificationActor,
  approvedNotificationItem,
} from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';
const pullRequest = {
  pullRequestDatabaseId: 45,
  pullRequestNodeId: 'PR_delivery',
  pullRequestNumber: 45,
};
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

function issueLifecycle() {
  return new GitHubIssueLifecycle({
    async cleanupGitHub() {
      return { status: 'missing' };
    },
    async inspectGitHub() {
      return undefined;
    },
    async prepareGitHub() {
      throw new Error('not used');
    },
  });
}

describe('channels/github/conversation/pull-request-handoff-service', () => {
  it('should baseline, record, and publish one idempotent issue-owned pull request handoff', async () => {
    const item = approvedNotificationItem();
    item.intake = {
      ...item.intake!,
      stage: 'prepared',
      worktreeBranch: 'issue-12',
      worktreePath: '/workspace/worktrees/issue-12',
    };
    const conversationId = githubNotificationConversationId({
      itemNumber: item.number,
      lifecycleId: item.lifecycleId,
      repositoryId: item.repositoryNodeId,
    });
    let state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const assignmentText = 'I reviewed the assignment and have a plan ready.';
    state.conversations[conversationId] = {
      assignmentResponse: {
        commentDatabaseId: 44,
        commentNodeId: 'IC_assignment',
        publicText: assignmentText,
        publicTextDigest: githubNotificationPublicTextDigest(assignmentText),
        status: 'published',
        target: githubNotificationPublicationTarget({
          conversationId,
          intent: 'assignment-response',
          publicationId: item.intake.assignmentEventId,
        }),
      },
      baselineEstablished: true,
      implementation: { status: 'delivery-pending' },
      itemKey: `github:${item.repositoryNodeId}:${item.number}`,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const baselineComment = {
      author: notificationActor,
      body: '@tanaabot comment before handoff',
      bodyTruncated: false,
      createdAt: '2026-08-25T12:00:00.000Z',
      databaseId: 91,
      nodeId: 'IC_pr_baseline',
      updatedAt: '2026-08-25T12:00:00.000Z',
    };
    let baselineReads = 0;
    let eventRecords = 0;
    let publications = 0;
    const recordInboundSession = async () => undefined;
    const service = new GitHubNotificationPullRequestHandoffService({
      assignmentAuthority: {
        async open() {
          return {
            authorized: true,
            client: {
              identity: notificationAccount,
              async getIssueComment() {
                throw new Error('not used');
              },
              async listIssueComments(owner, repository, number) {
                baselineReads += 1;
                assert.deepEqual([owner, repository, number], ['tanaabased', 'example', 45]);
                return { comments: [baselineComment], truncated: false };
              },
            },
            configuration: {
              approvedActors: [],
              assignmentTypes: ['issue' as const],
              intervalMinutes: 5,
            },
          };
        },
      },
      clock: () => 1_755_259_200_000,
      conversationStateStore: {
        async read() {
          return structuredClone(state);
        },
        async write(next) {
          state = structuredClone(next);
        },
      },
      events: new GitHubNotificationEventRegistry([githubNotificationPullRequestOpenedEvent]),
      logger: { error() {}, info() {}, warn() {} },
      publications: {
        async publish(input) {
          publications += 1;
          const handoff = state.conversations[conversationId]?.deliveryPullRequest?.handoff;
          assert.ok(handoff?.status === 'pending');
          assert.equal(input.target, handoff.target);
          assert.equal(input.text, handoff.publicText);
          return {
            receipt: { databaseId: 101, nodeId: 'IC_handoff' },
            status: 'published' as const,
            target: input.target,
          };
        },
      },
      readConfig: async () => config,
      recordInboundSession,
      async runPreparedReply(input) {
        eventRecords += 1;
        assert.equal(input.admission?.kind, 'observeOnly');
        assert.equal(input.recordInboundSession, recordInboundSession);
        assert.equal(input.record?.createIfMissing, false);
        assert.match(input.ctxPayload.Body ?? '', /Pull request opened/u);
        assert.match(input.ctxPayload.Body ?? '', /originating item/u);
        input.record?.trackSessionMetaTask?.(Promise.resolve({ sessionId: 'session-1' }));
        await input.afterRecord?.();
      },
    });
    const input = {
      agentId,
      item,
      lifecycle: issueLifecycle(),
      pullRequest,
      workspaceDir,
    };

    await service.link(input);
    await service.link(input);

    assert.equal(baselineReads, 1);
    assert.equal(eventRecords, 1);
    assert.equal(publications, 1);
    const source = state.conversations[conversationId]?.deliveryPullRequest;
    assert.deepEqual(source, {
      baselineEstablished: true,
      eventRecorded: true,
      handoff: {
        commentDatabaseId: 101,
        commentNodeId: 'IC_handoff',
        publicText: source?.handoff?.status === 'published' ? source.handoff.publicText : '',
        publicTextDigest:
          source?.handoff?.status === 'published' ? source.handoff.publicTextDigest : '',
        status: 'published',
        target: source?.handoff?.status === 'published' ? source.handoff.target : '',
      },
      itemDatabaseId: 45,
      nodeId: 'PR_delivery',
      number: 45,
      status: 'open',
    });
    assert.deepEqual(state.conversations[conversationId]?.revisions.IC_pr_baseline, {
      bodyDigest: githubCommentRevision(baselineComment).bodyDigest,
      commentDatabaseId: 91,
      reasonCode: 'comment-baseline',
      revisionId: githubCommentRevision(baselineComment).revisionId,
      source: { itemType: 'pull-request', number: 45 },
      status: 'baseline',
    });
  });
});
