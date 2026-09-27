import assert from 'node:assert/strict';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
} from '../channels/github/conversation/conversation-state.ts';
import GitHubNotificationPullRequestHandoffService, {
  GitHubNotificationPullRequestHandoffError,
} from '../channels/github/conversation/pull-request-handoff-service.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import {
  approvedNotificationItem,
  notificationAccount,
  notificationItemKey,
  notificationRepository,
} from './github-notification-fixtures.ts';
import {
  conversationSnapshot,
  replaceConversationSnapshot,
} from './github-notification-conversation-fixtures.ts';
import { resolveTestNotificationRoute } from './openclaw-agent-runtime.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';
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
  channels: { [githubNotificationChannelId]: { accounts: { [agentId]: { enabled: true } } } },
};

function fixture(status: 'pending' | 'delivery-pending' = 'pending') {
  const item = approvedNotificationItem();
  item.intake = {
    ...item.intake!,
    stage: 'prepared',
    worktreeBranch: 'issue-12',
    worktreePath: '/workspace/worktrees/issue-12',
  };
  const lifecycle = new GitHubIssueLifecycle({
    cleanupGitHub: async () => ({ status: 'missing' }),
    inspectGitHub: async () => undefined,
    prepareGitHub: async () => {
      throw new Error('unexpected preparation');
    },
  });
  const conversationId = githubNotificationConversationId({
    itemNumber: item.number,
    lifecycleId: item.lifecycleId,
    repositoryId: item.repositoryNodeId,
  });
  let state = createGitHubNotificationConversationState(agentId, workspaceDir);
  const assignmentText = 'I am working on this issue.';
  state.conversations[conversationId] = {
    assignmentResponse: {
      commentDatabaseId: 41,
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
    implementation: { status },
    itemKey: notificationItemKey,
    lifecycleId: 'issue',
    mode: 'work',
    revisions: {},
  };
  const counts = { baseline: 0, event: 0, handoff: 0, lookup: 0 };
  const control = {
    authorNodeId: notificationAccount.nodeId,
    baseRef: 'main',
    branch: 'issue-12',
    failBaseline: false,
    headRepositoryNodeId: notificationRepository.nodeId,
    numbers: [45],
    truncated: false,
  };
  const client = {
    identity: notificationAccount,
    async getIssueComment() {
      throw new Error('unexpected comment read');
    },
    async listIssueComments() {
      counts.baseline += 1;
      if (control.failBaseline) {
        control.failBaseline = false;
        throw new Error('interrupted baseline');
      }
      return { comments: [], truncated: false };
    },
    async listPullRequestsForBranch(owner: string, name: string, branch: string) {
      counts.lookup += 1;
      assert.deepEqual([owner, name, branch], ['tanaabased', 'example', 'issue-12']);
      return { numbers: control.numbers, truncated: control.truncated };
    },
    async getItem() {
      return {
        assignees: [],
        databaseId: 145,
        itemType: 'pull-request' as const,
        nodeId: 'PR_recovery',
        number: 45,
        pullRequest: {
          author: { ...notificationAccount, nodeId: control.authorNodeId },
          baseRef: control.baseRef,
          baseRepositoryDatabaseId: notificationRepository.databaseId,
          baseRepositoryNodeId: notificationRepository.nodeId,
          draft: false,
          headRef: control.branch,
          headRepositoryDatabaseId: notificationRepository.databaseId,
          headRepositoryNodeId: control.headRepositoryNodeId,
          headSha: 'a'.repeat(40),
          merged: false,
        },
        state: 'open' as const,
        updatedAt: '2026-09-27T00:00:00.000Z',
      };
    },
  };
  const authority = {
    async open() {
      return {
        authorized: true as const,
        client,
        configuration: {
          approvedActors: [],
          assignmentTypes: ['issue' as const],
          intervalMinutes: 5,
          maxConcurrentIssues: 2,
        },
      };
    },
  };
  const service = new GitHubNotificationPullRequestHandoffService({
    assignmentAuthority: authority,
    recoveryAuthority: authority,
    conversationStateStore: {
      async read(_agentId, selectedConversationId) {
        assert.equal(selectedConversationId, conversationId);
        return conversationSnapshot(state, selectedConversationId);
      },
      async write(next) {
        state = replaceConversationSnapshot(state, next);
      },
    },
    coordinator: {
      async run(input) {
        counts.event += 1;
        assert.equal(input.messageId, 'pull-request-opened:PR_recovery');
        return {
          dispatch: { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false },
          finalPayloadCount: 1,
          privateText: 'The pull request is linked.',
          publication: { status: 'none' },
        };
      },
    },
    logger: { error() {}, info() {}, warn() {} },
    publications: {
      async publish(input) {
        counts.handoff += 1;
        return {
          receipt: { databaseId: 101, nodeId: 'IC_handoff' },
          status: 'published' as const,
          target: input.target,
        };
      },
    },
    readConfig: () => config,
    resolveNotificationRoute: resolveTestNotificationRoute,
    turnContracts: {
      resolve: () =>
        ({
          identity: { eventId: 'pull-request-opened', lifecycleId: 'issue', modeId: 'work' },
        }) as GitHubNotificationTurnContract,
    },
  });
  return {
    control,
    counts,
    input: { agentId, executionSurface: 'gateway' as const, item, lifecycle, workspaceDir },
    service,
    state: () => state.conversations[conversationId]!,
  };
}

describe('channels/github/conversation/recovery-handoff', () => {
  for (const status of ['pending', 'delivery-pending'] as const) {
    it(`should link a verified managed-branch pull request from ${status} without claiming delivery`, async () => {
      const scenario = fixture(status);
      assert.equal(await scenario.service.recover(scenario.input), true);
      assert.equal(await scenario.service.recover(scenario.input), false);
      assert.equal(scenario.state().implementation?.status, 'recovery-linked');
      assert.equal(scenario.state().deliveryPullRequest?.nodeId, 'PR_recovery');
      assert.equal(scenario.state().deliveryPullRequest?.baselineEstablished, true);
      assert.equal(scenario.state().deliveryPullRequest?.handoff?.status, 'published');
      assert.deepEqual(scenario.counts, { baseline: 1, event: 1, handoff: 1, lookup: 1 });
    });
  }

  it('should retry an interrupted baseline with the same pull request', async () => {
    const scenario = fixture();
    scenario.control.failBaseline = true;
    await assert.rejects(
      scenario.service.recover(scenario.input),
      (error: unknown) =>
        error instanceof GitHubNotificationPullRequestHandoffError &&
        error.code === 'github-notification-pull-request-handoff-baseline-failed',
    );
    assert.equal(scenario.state().implementation?.status, 'recovery-linked');
    assert.equal(scenario.state().deliveryPullRequest?.number, 45);
    assert.equal(await scenario.service.recover(scenario.input), true);
    assert.deepEqual(scenario.counts, { baseline: 2, event: 1, handoff: 1, lookup: 1 });
  });

  it('should leave a missing pull request unlinked and reject ambiguous or incompatible matches', async () => {
    const scenario = fixture();
    scenario.control.numbers = [];
    assert.equal(await scenario.service.recover(scenario.input), false);
    scenario.control.numbers = [45, 46];
    await assert.rejects(scenario.service.recover(scenario.input), /ambiguous pull requests/u);
    scenario.control.numbers = [45];
    scenario.control.truncated = true;
    await assert.rejects(scenario.service.recover(scenario.input), /ambiguous pull requests/u);
    scenario.control.truncated = false;
    scenario.control.authorNodeId = 'U_unrelated';
    await assert.rejects(scenario.service.recover(scenario.input), /incompatible pull request/u);
    scenario.control.authorNodeId = notificationAccount.nodeId;
    scenario.control.branch = 'unrelated-branch';
    await assert.rejects(scenario.service.recover(scenario.input), /incompatible pull request/u);
    scenario.control.branch = 'issue-12';
    scenario.control.baseRef = 'unrelated-base';
    await assert.rejects(scenario.service.recover(scenario.input), /incompatible pull request/u);
    scenario.control.baseRef = 'main';
    scenario.control.headRepositoryNodeId = 'R_unrelated';
    await assert.rejects(scenario.service.recover(scenario.input), /incompatible pull request/u);
    assert.equal(scenario.state().implementation?.status, 'pending');
    assert.equal(scenario.state().deliveryPullRequest, undefined);
    assert.deepEqual(scenario.counts, { baseline: 0, event: 0, handoff: 0, lookup: 7 });
  });
});
