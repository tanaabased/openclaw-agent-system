import assert from 'node:assert/strict';

import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';
import {
  createMessageReceiptFromOutboundResults,
  type DurableInboundReplyDeliveryParams,
  type DurableInboundReplyDeliveryResult,
} from 'openclaw/plugin-sdk/channel-outbound';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import type { GitHubNotificationAssignmentInspection } from '../channels/github/intake/assignment-provider.ts';
import GitHubNotificationCommentOrchestrator, {
  GitHubNotificationCommentOrchestratorError,
} from '../channels/github/conversation/comment-orchestrator.ts';
import type GitHubWorkEventClient from '../channels/github/provider/work-event-client.ts';
import {
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
} from '../channels/github/conversation/comment-admission.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversationState,
} from '../channels/github/conversation/conversation-state.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/intake/monitor/state.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import {
  notificationAccount,
  notificationActor,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';
type DeliverInboundReply = (
  input: DurableInboundReplyDeliveryParams,
) => Promise<DurableInboundReplyDeliveryResult>;
const configuration = {
  assignmentTypes: ['issue', 'pull-request'] as Array<'issue' | 'pull-request'>,
  approvedActors: [{ login: notificationActor.login, nodeId: notificationActor.nodeId }],
  intervalMinutes: 5,
};

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

function comment(
  body = '@tanaabot reply with ready',
  overrides: Partial<GitHubCanonicalIssueComment> = {},
): GitHubCanonicalIssueComment {
  return {
    author: notificationActor,
    body,
    bodyTruncated: false,
    createdAt: '2026-08-15T12:00:00.000Z',
    databaseId: 91,
    nodeId: 'IC_comment',
    updatedAt: '2026-08-15T12:00:00.000Z',
    ...overrides,
  };
}

function authority(
  comments: GitHubCanonicalIssueComment[],
  truncated = false,
): { open(): Promise<GitHubNotificationAssignmentInspection> } {
  const client = {
    identity: notificationAccount,
    async getIssueComment(
      _owner: string,
      _repository: string,
      _number: number,
      databaseId: number,
    ) {
      const exact = comments.find((entry) => entry.databaseId === databaseId);
      if (!exact) throw new Error('missing test comment');
      return structuredClone(exact);
    },
    async listIssueComments() {
      return { comments: structuredClone(comments), truncated };
    },
  } as unknown as GitHubWorkEventClient;
  return {
    async open() {
      return { authorized: true, client, configuration };
    },
  };
}

function conversationId(monitor: GitHubNotificationMonitorState): string {
  const item = monitor.items[notificationItemKey]!;
  return githubNotificationConversationId({
    itemNumber: item.number,
    lifecycleId: item.lifecycleId,
    repositoryId: item.repositoryNodeId,
  });
}

function memoryStateStore(initial?: GitHubNotificationConversationState) {
  let state = initial === undefined ? undefined : structuredClone(initial);
  return {
    async read() {
      return state === undefined ? undefined : structuredClone(state);
    },
    snapshot() {
      return state === undefined ? undefined : structuredClone(state);
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

describe('channels/github/conversation/comment-orchestrator', () => {
  it('should persist an empty baseline without dispatching a turn', async () => {
    const monitor = preparedMonitor();
    const store = memoryStateStore();
    let turns = 0;
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([]),
      conversationStateStore: store,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: { publish: async () => Promise.reject(new Error('unexpected publication')) },
      turns: {
        async respond() {
          turns += 1;
          throw new Error('unexpected turn');
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.equal(turns, 0);
    assert.deepEqual(store.snapshot()?.conversations[conversationId(monitor)], {
      baselineEstablished: true,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    });
  });

  it('should dispatch one admitted revision and checkpoint one published reply', async () => {
    const monitor = preparedMonitor();
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const incoming = comment();
    const store = memoryStateStore(state);
    const observedBodies: string[] = [];
    const observedActiveTurns: unknown[] = [];
    const publishedTexts: string[] = [];
    const adapterReceipt = createMessageReceiptFromOutboundResults({
      kind: 'text',
      results: [
        {
          channel: githubNotificationChannelId,
          conversationId: id,
          messageId: '101',
          meta: { nodeId: 'IC_reply' },
        },
      ],
    });
    const deliveryResult: DurableInboundReplyDeliveryResult = {
      delivery: {
        messageIds: ['101'],
        receipt: createMessageReceiptFromOutboundResults({
          kind: 'text',
          results: [
            {
              messageId: '101',
              receipt: adapterReceipt,
            },
          ],
        }),
        visibleReplySent: true,
      },
      status: 'handled_visible',
    };
    assert.equal(deliveryResult.delivery.receipt?.raw?.[0]?.meta, undefined);
    assert.equal(deliveryResult.delivery.receipt?.parts[0]?.raw?.meta?.nodeId, 'IC_reply');
    const deliver: DeliverInboundReply = async (input) => {
      publishedTexts.push(input.payload.text ?? '');
      return deliveryResult;
    };
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([incoming]),
      conversationStateStore: store,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      deliver,
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turns: {
        async respond(input) {
          observedBodies.push(input.comment.body);
          observedActiveTurns.push(store.snapshot()?.conversations[id]?.activeTurn);
          return {
            accountId: agentId,
            agentId,
            config: {},
            ctxPayload: {} as AssembledInboundReply['ctxPayload'],
            privateText: 'Private ready response.',
            publication: { status: 'candidate', publicText: 'ready' },
          };
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.deepEqual(observedBodies, [incoming.body]);
    assert.deepEqual(observedActiveTurns, [
      { eventId: 'comment', sourceId: githubCommentRevision(incoming).revisionId },
    ]);
    assert.deepEqual(publishedTexts, ['ready']);
    assert.equal(store.snapshot()?.conversations[id]?.activeTurn, undefined);
    const revision = store.snapshot()?.conversations[id]?.revisions[incoming.nodeId];
    assert.equal(revision?.revisionId, githubCommentRevision(incoming).revisionId);
    assert.equal(revision?.status, 'responded');
    const publication = revision?.publication;
    assert.ok(publication && publication.status === 'published');
    assert.deepEqual(publication, {
      commentDatabaseId: 101,
      commentNodeId: 'IC_reply',
      publicText: 'ready',
      publicTextDigest: githubNotificationPublicTextDigest('ready'),
      status: 'published',
      target: publication.target,
    });
  });

  it('should retain the active turn when response dispatch remains retryable', async () => {
    const monitor = preparedMonitor();
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const incoming = comment();
    const revision = githubCommentRevision(incoming);
    const store = memoryStateStore(state);
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([incoming]),
      conversationStateStore: store,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turns: {
        async respond() {
          assert.deepEqual(store.snapshot()?.conversations[id]?.activeTurn, {
            eventId: 'comment',
            sourceId: revision.revisionId,
          });
          throw new Error('model dispatch failed');
        },
      },
    });

    await assert.rejects(
      orchestrator.reconcile(agentId, notificationItemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentOrchestratorError &&
        error.code === 'github-notification-comment-reconciliation-failed' &&
        error.cause instanceof Error &&
        error.cause.message === 'model dispatch failed',
    );
    assert.deepEqual(store.snapshot()?.conversations[id]?.activeTurn, {
      eventId: 'comment',
      sourceId: revision.revisionId,
    });
    assert.deepEqual(store.snapshot()?.conversations[id]?.revisions[incoming.nodeId], {
      bodyDigest: revision.bodyDigest,
      commentDatabaseId: incoming.databaseId,
      failureCode: 'github-notification-comment-reconciliation-failed',
      reasonCode: 'comment-approved',
      revisionId: revision.revisionId,
      status: 'admitted',
    });
  });

  it('should retain the private response and checkpoint a withheld publication', async () => {
    const monitor = preparedMonitor();
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const incoming = comment();
    const store = memoryStateStore(state);
    let deliveries = 0;
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([incoming]),
      conversationStateStore: store,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      deliver: async () => {
        deliveries += 1;
        throw new Error('unexpected delivery');
      },
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turns: {
        async respond() {
          return {
            accountId: agentId,
            agentId,
            config: {},
            ctxPayload: {} as AssembledInboundReply['ctxPayload'],
            privateText: 'The successful private response.',
            publication: {
              status: 'withheld',
              code: 'github-notification-publication-candidate-missing',
            },
          };
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.equal(deliveries, 0);
    assert.deepEqual(store.snapshot()?.conversations[id]?.revisions[incoming.nodeId], {
      bodyDigest: githubCommentRevision(incoming).bodyDigest,
      commentDatabaseId: incoming.databaseId,
      publication: {
        reasonCode: 'github-notification-publication-candidate-missing',
        status: 'withheld',
      },
      reasonCode: 'comment-approved',
      revisionId: githubCommentRevision(incoming).revisionId,
      status: 'responded',
    });
  });

  it('should fail closed when a publication receipt omits the github node id', async () => {
    const monitor = preparedMonitor();
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const incoming = comment();
    const store = memoryStateStore(state);
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([incoming]),
      conversationStateStore: store,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      deliver: async () => ({
        delivery: {
          messageIds: ['101'],
          receipt: createMessageReceiptFromOutboundResults({
            kind: 'text',
            results: [{ messageId: '101' }],
          }),
          visibleReplySent: true,
        },
        status: 'handled_visible',
      }),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turns: {
        async respond() {
          return {
            accountId: agentId,
            agentId,
            config: {},
            ctxPayload: {} as AssembledInboundReply['ctxPayload'],
            privateText: 'Private ready response.',
            publication: { status: 'candidate', publicText: 'ready' },
          };
        },
      },
    });

    await assert.rejects(
      orchestrator.reconcile(agentId, notificationItemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentOrchestratorError &&
        error.code === 'github-notification-publication-receipt-invalid',
    );
    const revision = store.snapshot()?.conversations[id]?.revisions[incoming.nodeId];
    assert.equal(revision?.status, 'responded');
    assert.equal(revision?.publication?.status, 'pending');
    assert.equal(revision?.publication?.commentDatabaseId, undefined);
    assert.equal(revision?.publication?.commentNodeId, undefined);
  });

  it('should reject a truncated listing without accepting a partial baseline', async () => {
    const monitor = preparedMonitor();
    const store = memoryStateStore();
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([], true),
      conversationStateStore: store,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: { publish: async () => Promise.reject(new Error('unexpected publication')) },
      turns: { respond: async () => Promise.reject(new Error('unexpected turn')) },
    });

    await assert.rejects(
      orchestrator.reconcile(agentId, notificationItemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentOrchestratorError &&
        error.code === 'github-notification-comments-truncated',
    );
    assert.equal(store.snapshot(), undefined);
  });
});
