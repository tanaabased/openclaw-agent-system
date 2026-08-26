import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import { githubCommentRevision } from '../channels/github/conversation/comment-admission.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
} from '../channels/github/conversation/conversation-state.ts';
import type { GitHubNotificationModelTurnCoordinatorResult } from '../channels/github/conversation/model-turn-coordinator.ts';
import GitHubNotificationPullRequestHandoffService, {
  GitHubNotificationPullRequestHandoffError,
} from '../channels/github/conversation/pull-request-handoff-service.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
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

function privateEventResult(): GitHubNotificationModelTurnCoordinatorResult {
  return {
    dispatch: { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false },
    finalPayloadCount: 1,
    privateText: 'The delivery pull request is linked to this session.',
    publication: { status: 'none' },
  };
}

describe('channels/github/conversation/pull-request-handoff-service', () => {
  it('should checkpoint, baseline, dispatch, and publish one idempotent issue-owned handoff', async () => {
    const item = approvedNotificationItem();
    item.intake = {
      ...item.intake!,
      stage: 'prepared',
      worktreeBranch: 'issue-12',
      worktreePath: '/workspace/worktrees/issue-12',
    };
    const lifecycle = issueLifecycle();
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
    let eventTurns = 0;
    let publications = 0;
    const contract = {
      identity: { eventId: 'pull-request-opened', lifecycleId: 'issue', modeId: 'work' },
      instructions: 'trusted pull request opened instructions',
      lifecycle,
      mode: { disableTools: false, id: 'work' },
    } as GitHubNotificationTurnContract;
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
      coordinator: {
        async run(input) {
          eventTurns += 1;
          assert.equal(input.contract, contract);
          assert.equal(input.createIfMissing, false);
          assert.equal(input.executionSurface, 'cli-one-shot');
          assert.equal(input.messageId, 'pull-request-opened:PR_delivery');
          assert.equal(input.sourceId, 'PR_delivery');
          assert.equal(input.ctxPayload.Provider, githubNotificationChannelId);
          assert.match(input.ctxPayload.Body ?? '', /Pull request opened/u);
          assert.match(input.ctxPayload.Body ?? '', /originating item/u);
          assert.deepEqual(state.conversations[conversationId]?.activeTurn, {
            eventId: 'pull-request-opened',
            sourceId: 'PR_delivery',
          });
          return privateEventResult();
        },
      },
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
      turnContracts: {
        resolve(identity, resolvedConfig, resolvedAgentId) {
          assert.deepEqual(identity, contract.identity);
          assert.equal(resolvedConfig, config);
          assert.equal(resolvedAgentId, agentId);
          return contract;
        },
      },
    });
    const checkpointInput = {
      agentId,
      executionSurface: 'cli-one-shot' as const,
      item,
      lifecycle,
      pullRequest,
      workspaceDir,
    };
    const reconcileInput = {
      agentId,
      executionSurface: 'cli-one-shot' as const,
      item,
      lifecycle,
      workspaceDir,
    };

    await service.checkpoint(checkpointInput);
    state.conversations[conversationId]!.implementation = { status: 'completed' };
    await service.reconcile(reconcileInput);
    await service.reconcile(reconcileInput);

    assert.equal(baselineReads, 1);
    assert.equal(eventTurns, 1);
    assert.equal(publications, 1);
    assert.equal(state.conversations[conversationId]?.activeTurn, undefined);
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

  it('should report the exact handoff phase when the pull request baseline fails', async () => {
    const item = approvedNotificationItem();
    const lifecycle = issueLifecycle();
    const conversationId = githubNotificationConversationId({
      itemNumber: item.number,
      lifecycleId: item.lifecycleId,
      repositoryId: item.repositoryNodeId,
    });
    let state = createGitHubNotificationConversationState(agentId, workspaceDir);
    state.conversations[conversationId] = {
      baselineEstablished: true,
      deliveryPullRequest: {
        baselineEstablished: false,
        eventRecorded: false,
        nodeId: 'PR_delivery',
        number: 45,
        status: 'open',
      },
      implementation: { status: 'completed' },
      itemKey: `github:${item.repositoryNodeId}:${item.number}`,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const warnings: string[] = [];
    const service = new GitHubNotificationPullRequestHandoffService({
      assignmentAuthority: {
        async open() {
          throw Object.assign(new Error('provider read failed'), {
            code: 'github-notification-provider-read-failed',
          });
        },
      },
      conversationStateStore: {
        async read() {
          return structuredClone(state);
        },
        async write(next) {
          state = structuredClone(next);
        },
      },
      coordinator: { run: async () => Promise.reject(new Error('unexpected turn')) },
      logger: {
        error() {},
        info() {},
        warn(message) {
          warnings.push(message);
        },
      },
      publications: { publish: async () => Promise.reject(new Error('unexpected publication')) },
      readConfig: async () => config,
      turnContracts: { resolve: () => Promise.reject(new Error('unexpected contract')) as never },
    });

    await assert.rejects(
      service.reconcile({
        agentId,
        executionSurface: 'gateway',
        item,
        lifecycle,
        workspaceDir,
      }),
      (error: unknown) =>
        error instanceof GitHubNotificationPullRequestHandoffError &&
        error.code === 'github-notification-pull-request-handoff-baseline-failed',
    );
    assert.deepEqual(warnings, [
      'github-notifications: pull request handoff failed phase=baseline code=github-notification-pull-request-handoff-baseline-failed causeCode=github-notification-provider-read-failed',
    ]);
  });
});
