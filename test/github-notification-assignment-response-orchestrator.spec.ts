import assert from 'node:assert/strict';

import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';
import {
  createMessageReceiptFromOutboundResults,
  type DurableInboundReplyDeliveryResult,
} from 'openclaw/plugin-sdk/channel-outbound';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import GitHubNotificationAssignmentResponseOrchestrator from '../channels/github/conversation/assignment-response-orchestrator.ts';
import {
  createGitHubNotificationConversationState,
  type GitHubNotificationConversationState,
} from '../channels/github/conversation/conversation-state.ts';
import type { GitHubNotificationAssignmentInspection } from '../channels/github/intake/assignment-provider.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/intake/monitor/state.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import type { GitHubNotificationItemContextClient } from '../channels/github/provider/work-event-client.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';

function preparedMonitor(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  state.agentId = agentId;
  state.workspaceDir = workspaceDir;
  const intake = state.items[notificationItemKey]?.intake;
  assert.ok(intake);
  state.items[notificationItemKey]!.intake = {
    ...intake,
    stage: 'prepared',
    worktreeBranch: 'issue-12',
    worktreePath: '/workspace/worktrees/issue-12',
  };
  return state;
}

function memoryStateStore(initial: GitHubNotificationConversationState) {
  let state = structuredClone(initial);
  return {
    async read() {
      return structuredClone(state);
    },
    snapshot() {
      return structuredClone(state);
    },
    async write(next: GitHubNotificationConversationState) {
      state = structuredClone(next);
    },
  };
}

function lifecycles() {
  return new GitHubNotificationLifecycleRegistry([
    new GitHubIssueLifecycle({
      async inspectGitHub() {
        return undefined;
      },
      async prepareGitHub() {
        throw new Error('not used');
      },
    }),
  ]);
}

describe('channels/github/conversation/assignment-response-orchestrator', () => {
  it('should publish one assignment response and remain idempotent', async () => {
    const monitor = preparedMonitor();
    const item = monitor.items[notificationItemKey]!;
    const intake = item.intake!;
    const conversationId = githubNotificationConversationId({
      itemNumber: item.number,
      lifecycleId: item.lifecycleId,
      repositoryId: item.repositoryNodeId,
    });
    const initial = createGitHubNotificationConversationState(agentId, workspaceDir);
    initial.conversations[conversationId] = {
      baselineEstablished: false,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const conversations = memoryStateStore(initial);
    const calls: unknown[][] = [];
    const contextClient: GitHubNotificationItemContextClient = {
      async getItemContext(owner, name, number, itemType) {
        calls.push(['context', owner, name, number, itemType]);
        return {
          body: 'Saving the form currently produces an error instead of the updated result.',
          comments: [],
          labels: ['bug'],
          title: 'Save the updated form',
          truncated: false,
        };
      },
    };
    const authority = {
      async open(): Promise<
        GitHubNotificationAssignmentInspection<GitHubNotificationItemContextClient>
      > {
        return {
          authorized: true,
          client: contextClient,
          configuration: {
            assignmentTypes: ['issue'],
            approvedActors: [],
            intervalMinutes: 5,
          },
        };
      },
    };
    const adapterReceipt = createMessageReceiptFromOutboundResults({
      kind: 'text',
      results: [
        {
          channel: 'agent-system-github',
          conversationId,
          messageId: '501',
          meta: { nodeId: 'IC_plan' },
        },
      ],
    });
    const deliveryResult: DurableInboundReplyDeliveryResult = {
      delivery: {
        messageIds: ['501'],
        receipt: createMessageReceiptFromOutboundResults({
          kind: 'text',
          results: [{ messageId: '501', receipt: adapterReceipt }],
        }),
        visibleReplySent: true,
      },
      status: 'handled_visible',
    };
    const orchestrator = new GitHubNotificationAssignmentResponseOrchestrator({
      assignmentAuthority: authority,
      conversationStateStore: conversations,
      async deliver(input) {
        calls.push(['deliver', input.to, input.payload.text]);
        return deliveryResult;
      },
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles(),
      logger: {
        debug() {},
        error() {},
        info(message) {
          calls.push(['info', message]);
        },
        warn() {},
      },
      monitorStateStore: {
        async read() {
          return structuredClone(monitor);
        },
      },
      publications: {
        async publish() {
          throw new Error('unexpected retry');
        },
      },
      turnCatalog: {
        resolve(identity) {
          calls.push(['catalog', identity]);
          return {} as never;
        },
      },
      turns: {
        async respond(input) {
          calls.push([
            'turn',
            input.sourceId,
            input.itemContext.title,
            input.worktree,
            input.mode.policy.label,
          ]);
          return {
            accountId: agentId,
            agentId,
            config: {},
            ctxPayload: {} as AssembledInboundReply['ctxPayload'],
            privateText:
              '## Assessment\n\nThe user needs the form to save successfully.\n\n## Plan\n\nUpdate the owning behavior and verify the save flow.',
            publication: {
              publicText:
                'I found the failing save path and have a focused implementation and validation plan.',
              status: 'candidate' as const,
            },
          };
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey, {
      executionSurface: 'gateway',
    });
    await orchestrator.reconcile(agentId, notificationItemKey, {
      executionSurface: 'gateway',
    });

    const assignmentResponse =
      conversations.snapshot().conversations[conversationId]!.assignmentResponse;
    assert.deepEqual(assignmentResponse, {
      publication: {
        commentDatabaseId: 501,
        commentNodeId: 'IC_plan',
        publicText:
          'I found the failing save path and have a focused implementation and validation plan.',
        publicTextDigest: assignmentResponse?.publication.publicTextDigest,
        status: 'published',
        target: assignmentResponse?.publication.target,
      },
      sourceId: intake.assignmentEventId,
    });
    assert.equal(conversations.snapshot().conversations[conversationId]!.activeTurn, undefined);
    assert.deepEqual(
      calls.filter(([kind]) => kind === 'turn'),
      [
        [
          'turn',
          intake.assignmentEventId,
          'Save the updated form',
          { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
          'Work',
        ],
      ],
    );
    assert.equal(calls.filter(([kind]) => kind === 'deliver').length, 1);
  });
});
