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
import type {
  GitHubNotificationCommentClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-client.ts';
import {
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
} from '../channels/github/conversation/comment-admission.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversationState,
} from '../channels/github/conversation/conversation-state.ts';
import GitHubNotificationTurnCatalog, {
  githubNotificationSupportedTurnIdentities,
} from '../channels/github/conversation/turn-catalog.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/intake/monitor/state.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import {
  notificationAccount,
  notificationActor,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';
import { createGitHubNotificationTurnDefinitions } from './github-notification-turn-fixtures.ts';

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
const turnCatalog = new GitHubNotificationTurnCatalog(
  githubNotificationSupportedTurnIdentities,
  createGitHubNotificationTurnDefinitions(),
);

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
): {
  open(): Promise<
    GitHubNotificationAssignmentInspection<
      GitHubNotificationCommentClient & GitHubNotificationItemContextClient
    >
  >;
} {
  const client: GitHubNotificationCommentClient & GitHubNotificationItemContextClient = {
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
    async getItemContext() {
      return {
        body: 'Current behavior differs from the expected result.',
        comments: [],
        labels: [],
        title: 'Test issue',
        truncated: false,
      };
    },
  };
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
    const item = monitor.items[notificationItemKey]!;
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    const publicText = "Got it — I'm starting on this now.";
    const acknowledgment = {
      commentDatabaseId: 90,
      commentNodeId: 'IC_acknowledgment',
      publicText,
      publicTextDigest: githubNotificationPublicTextDigest(publicText),
      status: 'published' as const,
      target: githubNotificationPublicationTarget({
        intent: 'initial-acknowledgment',
        item,
        publicationId: item.intake!.assignmentEventId,
      }),
    };
    state.conversations[id] = {
      acknowledgment,
      baselineEstablished: false,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const store = memoryStateStore(state);
    let turns = 0;
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([]),
      conversationStateStore: store,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: { publish: async () => Promise.reject(new Error('unexpected publication')) },
      turnCatalog,
      turns: {
        async respond() {
          turns += 1;
          throw new Error('unexpected turn');
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.equal(turns, 0);
    assert.deepEqual(store.snapshot()?.conversations[id], {
      acknowledgment,
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
    const observedMentions: unknown[] = [];
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
      turnCatalog,
      turns: {
        async respond(input) {
          observedBodies.push(input.comment.body);
          observedMentions.push(input.mentions);
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
    assert.deepEqual(observedMentions, [[{ end: 9, start: 0 }]]);
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

  it('should resume assignment planning from an admitted clarification answer', async () => {
    const monitor = preparedMonitor();
    const item = monitor.items[notificationItemKey]!;
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    const questionText = 'I need one detail before I can finish the plan: which result should win?';
    state.conversations[id] = {
      baselineEstablished: true,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      planning: {
        outcome: 'questions',
        publication: {
          commentDatabaseId: 100,
          commentNodeId: 'IC_questions',
          publicText: questionText,
          publicTextDigest: githubNotificationPublicTextDigest(questionText),
          status: 'published',
          target: githubNotificationPublicationTarget({
            intent: 'planning-outcome',
            item,
            publicationId: item.intake!.assignmentEventId,
          }),
        },
        sourceId: item.intake!.assignmentEventId,
      },
      revisions: {},
    };
    const incoming = comment('@tanaabot The newer saved value should win.');
    const revision = githubCommentRevision(incoming);
    const store = memoryStateStore(state);
    const observed: unknown[] = [];
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([incoming]),
      conversationStateStore: store,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: {
        async publish(input) {
          observed.push(['publish', input.text, input.target]);
          return {
            receipt: { databaseId: 102, nodeId: 'IC_plan' },
            status: 'published' as const,
            target: input.target,
          };
        },
      },
      turnCatalog,
      turns: {
        async respond(input) {
          observed.push([
            'turn',
            input.eventId,
            input.itemContext?.title,
            store.snapshot()?.conversations[id]?.activeTurn,
          ]);
          return {
            accountId: agentId,
            agentId,
            config: {},
            ctxPayload: {} as AssembledInboundReply['ctxPayload'],
            privateText:
              '## Assessment\n\nThe user confirmed the newer value should win.\n\n## Plan\n\nUpdate the precedence rule and verify the save flow.',
            publication: {
              planningOutcome: 'plan' as const,
              publicText: 'Thanks, that resolves the ambiguity. I now have a complete plan.',
              status: 'candidate' as const,
            },
          };
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.deepEqual(observed[0], [
      'turn',
      'assignment-clarification',
      'Test issue',
      { eventId: 'assignment-clarification', sourceId: revision.revisionId },
    ]);
    assert.equal((observed[1] as unknown[])[0], 'publish');
    const conversation = store.snapshot()?.conversations[id];
    assert.equal(conversation?.activeTurn, undefined);
    assert.equal(conversation?.revisions[incoming.nodeId]?.status, 'continued');
    assert.deepEqual(conversation?.planning, {
      outcome: 'plan',
      publication: {
        commentDatabaseId: 102,
        commentNodeId: 'IC_plan',
        publicText: 'Thanks, that resolves the ambiguity. I now have a complete plan.',
        publicTextDigest: githubNotificationPublicTextDigest(
          'Thanks, that resolves the ambiguity. I now have a complete plan.',
        ),
        status: 'published',
        target: conversation?.planning?.publication.target,
      },
      sourceId: revision.revisionId,
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
      turnCatalog,
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
      turnCatalog,
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
      turnCatalog,
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

  it('should reject an undeclared active tuple before reading provider comments', async () => {
    const monitor = preparedMonitor();
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'plan',
      revisions: {},
    };
    let providerReads = 0;
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: {
        async open() {
          providerReads += 1;
          throw new Error('unsupported turns must not read provider comments');
        },
      },
      conversationStateStore: memoryStateStore(state),
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publications: { publish: async () => Promise.reject(new Error('unexpected publication')) },
      turnCatalog,
      turns: { respond: async () => Promise.reject(new Error('unexpected turn')) },
    });

    await assert.rejects(
      orchestrator.reconcile(agentId, notificationItemKey),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentOrchestratorError &&
        error.code === 'github-notification-turn-unsupported',
    );
    assert.equal(providerReads, 0);
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
      turnCatalog,
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
