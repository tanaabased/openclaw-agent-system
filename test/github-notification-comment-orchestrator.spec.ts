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
  GitHubNotificationIntakeClient,
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
type CommentClient = GitHubNotificationCommentClient &
  Pick<GitHubNotificationIntakeClient, 'getItem'>;
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
  open(): Promise<GitHubNotificationAssignmentInspection<CommentClient>>;
} {
  const client: CommentClient = {
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
    async getItem() {
      throw new Error('unexpected delivery pull request read');
    },
  };
  return {
    async open() {
      return { authorized: true, client, configuration };
    },
  };
}

function deliveryPullRequestItem(merged: boolean, state: 'closed' | 'open') {
  return {
    assignees: [],
    databaseId: 145,
    itemType: 'pull-request' as const,
    nodeId: 'PR_delivery',
    number: 45,
    pullRequest: {
      baseRef: 'main',
      baseRepositoryDatabaseId: 3,
      baseRepositoryNodeId: 'R_repo',
      draft: false,
      headRef: 'issue-12',
      headRepositoryDatabaseId: 3,
      headRepositoryNodeId: 'R_repo',
      headSha: 'a'.repeat(40),
      merged,
    },
    state,
    updatedAt: '2026-08-25T12:00:00.000Z',
  };
}

function terminalAuthority(merged: boolean): {
  open(): Promise<GitHubNotificationAssignmentInspection<CommentClient>>;
} {
  return {
    async open() {
      return {
        authorized: true,
        client: {
          identity: notificationAccount,
          async getIssueComment() {
            throw new Error('unexpected comment read');
          },
          async getItem() {
            return deliveryPullRequestItem(merged, 'closed');
          },
          async listIssueComments() {
            throw new Error('terminal transitions must stop before comment reads');
          },
        },
        configuration,
      };
    },
  };
}

function reopenedAuthority(
  comments: GitHubCanonicalIssueComment[],
  listedNumbers: number[],
): {
  open(): Promise<GitHubNotificationAssignmentInspection<CommentClient>>;
} {
  return {
    async open() {
      return {
        authorized: true,
        client: {
          identity: notificationAccount,
          async getIssueComment() {
            throw new Error('fresh baselines must stop before exact comment reads');
          },
          async getItem() {
            return deliveryPullRequestItem(false, 'open');
          },
          async listIssueComments(_owner: string, _repository: string, number: number) {
            listedNumbers.push(number);
            return {
              comments: number === 45 ? structuredClone(comments) : [],
              truncated: false,
            };
          },
        },
        configuration,
      };
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

function monitorStateStore(initial: GitHubNotificationMonitorState) {
  let state = structuredClone(initial);
  return {
    async read() {
      return structuredClone(state);
    },
    snapshot() {
      return structuredClone(state);
    },
    async write(next: GitHubNotificationMonitorState) {
      state = structuredClone(next);
    },
  };
}

function lifecycles() {
  return new GitHubNotificationLifecycleRegistry([
    new GitHubIssueLifecycle({
      async cleanupGitHub() {
        return { status: 'missing' };
      },
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
  it('should checkpoint the configured guided mode when establishing a conversation', async () => {
    const monitor = preparedMonitor();
    const store = memoryStateStore();
    const id = conversationId(monitor);
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority([]),
      conversationStateStore: store,
      async initialModeId(input) {
        assert.deepEqual(input, { agentId, workspaceDir });
        return 'guided' as const;
      },
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: monitorStateStore(monitor),
      publications: { publish: async () => Promise.reject(new Error('unexpected publication')) },
      turnCatalog,
      turns: { respond: async () => Promise.reject(new Error('unexpected turn')) },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.equal(store.snapshot()?.conversations[id]?.mode, 'guided');
  });

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
      monitorStateStore: monitorStateStore(monitor),
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
      monitorStateStore: monitorStateStore(monitor),
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

  it('should drain two admitted comments serially before yielding the poll cycle', async () => {
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
    const comments = [
      comment('@tanaabot first', {
        createdAt: '2026-08-15T12:00:00.000Z',
        databaseId: 91,
        nodeId: 'IC_first',
        updatedAt: '2026-08-15T12:00:00.000Z',
      }),
      comment('@tanaabot second', {
        createdAt: '2026-08-15T12:01:00.000Z',
        databaseId: 92,
        nodeId: 'IC_second',
        updatedAt: '2026-08-15T12:01:00.000Z',
      }),
      comment('@tanaabot third', {
        createdAt: '2026-08-15T12:02:00.000Z',
        databaseId: 93,
        nodeId: 'IC_third',
        updatedAt: '2026-08-15T12:02:00.000Z',
      }),
    ];
    const store = memoryStateStore(state);
    const responded: number[] = [];
    let receiptId = 200;
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: authority(comments),
      conversationStateStore: store,
      deliver: async () => {
        receiptId += 1;
        return {
          delivery: {
            messageIds: [String(receiptId)],
            receipt: createMessageReceiptFromOutboundResults({
              kind: 'text',
              results: [
                {
                  channel: githubNotificationChannelId,
                  conversationId: id,
                  messageId: String(receiptId),
                  meta: { nodeId: `IC_reply_${receiptId}` },
                },
              ],
            }),
            visibleReplySent: true,
          },
          status: 'handled_visible',
        };
      },
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: monitorStateStore(monitor),
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turnCatalog,
      turns: {
        async respond(input) {
          responded.push(input.comment.databaseId);
          return {
            accountId: agentId,
            agentId,
            config: {},
            ctxPayload: {} as AssembledInboundReply['ctxPayload'],
            privateText: `ready-${input.comment.databaseId}`,
            publication: {
              status: 'candidate',
              publicText: `ready-${input.comment.databaseId}`,
            },
          };
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.deepEqual(responded, [91, 92]);
    assert.equal(store.snapshot()?.conversations[id]?.revisions.IC_first?.status, 'responded');
    assert.equal(store.snapshot()?.conversations[id]?.revisions.IC_second?.status, 'responded');
    assert.equal(store.snapshot()?.conversations[id]?.revisions.IC_third, undefined);

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.deepEqual(responded, [91, 92, 93]);
    assert.equal(store.snapshot()?.conversations[id]?.revisions.IC_third?.status, 'responded');
  });

  it('should admit a delivery pull request comment by stable node and number identity', async () => {
    const monitor = preparedMonitor();
    const item = monitor.items[notificationItemKey]!;
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      deliveryPullRequest: {
        baselineEstablished: true,
        eventRecorded: true,
        nodeId: 'PR_delivery',
        number: 45,
        status: 'open',
      },
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const incoming = comment('@tanaabot reply from the pull request', {
      databaseId: 145,
      nodeId: 'IC_pr_comment',
    });
    const store = memoryStateStore(state);
    const listedNumbers: number[] = [];
    let destinationTarget = '';
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: {
        async open() {
          return {
            authorized: true,
            client: {
              identity: notificationAccount,
              async getIssueComment(_owner, _repository, number) {
                assert.equal(number, 45);
                return structuredClone(incoming);
              },
              async getItem(_owner, _repository, number) {
                assert.equal(number, 45);
                return {
                  assignees: [],
                  databaseId: 145,
                  itemType: 'pull-request' as const,
                  nodeId: 'PR_delivery',
                  number: 45,
                  pullRequest: {
                    baseRef: 'main',
                    baseRepositoryDatabaseId: 3,
                    baseRepositoryNodeId: 'R_repo',
                    draft: false,
                    headRef: 'issue-12',
                    headRepositoryDatabaseId: 3,
                    headRepositoryNodeId: 'R_repo',
                    headSha: 'a'.repeat(40),
                    merged: false,
                  },
                  state: 'open' as const,
                  updatedAt: '2026-08-25T12:00:00.000Z',
                };
              },
              async listIssueComments(_owner, _repository, number) {
                listedNumbers.push(number);
                return {
                  comments: number === 45 ? [structuredClone(incoming)] : [],
                  truncated: false,
                };
              },
            },
            configuration,
          };
        },
      },
      conversationStateStore: store,
      deliver: async (delivery) => {
        destinationTarget = delivery.to ?? '';
        return {
          delivery: {
            messageIds: ['201'],
            receipt: createMessageReceiptFromOutboundResults({
              kind: 'text',
              results: [
                {
                  channel: githubNotificationChannelId,
                  conversationId: id,
                  messageId: '201',
                  meta: { nodeId: 'IC_pr_reply' },
                },
              ],
            }),
            visibleReplySent: true,
          },
          status: 'handled_visible',
        };
      },
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: monitorStateStore(monitor),
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turnCatalog,
      turns: {
        async respond(turn) {
          assert.deepEqual(turn.item, item);
          assert.deepEqual(turn.source, { itemType: 'pull-request', number: 45 });
          return {
            accountId: agentId,
            agentId,
            config: {},
            ctxPayload: {} as AssembledInboundReply['ctxPayload'],
            privateText: 'Private pull request response.',
            publication: { status: 'candidate', publicText: 'ready on the pull request' },
          };
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.deepEqual(listedNumbers, [12, 45]);
    assert.match(destinationTarget, /^github:issue:R_repo:12:publication:github-reply:/u);
    const revision = store.snapshot()?.conversations[id]?.revisions.IC_pr_comment;
    assert.deepEqual(revision?.source, { itemType: 'pull-request', number: 45 });
    assert.equal(revision?.publication?.status, 'published');
  });

  it('should unlink a closed unmerged pull request without retiring the issue conversation', async () => {
    const monitor = preparedMonitor();
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      deliveryPullRequest: {
        baselineEstablished: true,
        eventRecorded: true,
        nodeId: 'PR_delivery',
        number: 45,
        status: 'open',
      },
      implementation: { status: 'completed' },
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const conversations = memoryStateStore(state);
    const monitors = monitorStateStore(monitor);
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: terminalAuthority(false),
      conversationStateStore: conversations,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: monitors,
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turnCatalog,
      turns: { respond: async () => Promise.reject(new Error('unexpected turn')) },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.deepEqual(conversations.snapshot()?.conversations[id]?.deliveryPullRequest, {
      baselineEstablished: false,
      eventRecorded: true,
      nodeId: 'PR_delivery',
      number: 45,
      status: 'closed',
    });
    assert.equal(monitors.snapshot().items[notificationItemKey]?.disposition, 'approved');
  });

  it('should establish a fresh baseline before admitting comments from a reopened pull request', async () => {
    const monitor = preparedMonitor();
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      deliveryPullRequest: {
        baselineEstablished: false,
        eventRecorded: true,
        nodeId: 'PR_delivery',
        number: 45,
        status: 'closed',
      },
      implementation: { status: 'completed' },
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const historicComment = comment('@tanaabot historic pull request comment', {
      databaseId: 92,
      nodeId: 'IC_historic_pr_comment',
    });
    const listedNumbers: number[] = [];
    const conversations = memoryStateStore(state);
    let turns = 0;
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: reopenedAuthority([historicComment], listedNumbers),
      conversationStateStore: conversations,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: monitorStateStore(monitor),
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turnCatalog,
      turns: {
        async respond() {
          turns += 1;
          throw new Error('unexpected turn');
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.deepEqual(listedNumbers, []);
    assert.deepEqual(conversations.snapshot()?.conversations[id]?.deliveryPullRequest, {
      baselineEstablished: false,
      eventRecorded: true,
      nodeId: 'PR_delivery',
      number: 45,
      status: 'open',
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.deepEqual(listedNumbers, [12, 45]);
    assert.equal(turns, 0);
    assert.equal(
      conversations.snapshot()?.conversations[id]?.deliveryPullRequest?.baselineEstablished,
      true,
    );
    assert.deepEqual(
      conversations.snapshot()?.conversations[id]?.revisions.IC_historic_pr_comment,
      {
        bodyDigest: githubCommentRevision(historicComment).bodyDigest,
        commentDatabaseId: 92,
        reasonCode: 'comment-baseline',
        revisionId: githubCommentRevision(historicComment).revisionId,
        source: { itemType: 'pull-request', number: 45 },
        status: 'baseline',
      },
    );
  });

  it('should retire the issue-owned session when the delivery pull request is merged', async () => {
    const monitor = preparedMonitor();
    const state = createGitHubNotificationConversationState(agentId, workspaceDir);
    const id = conversationId(monitor);
    state.conversations[id] = {
      baselineEstablished: true,
      deliveryPullRequest: {
        baselineEstablished: true,
        eventRecorded: true,
        nodeId: 'PR_delivery',
        number: 45,
        status: 'open',
      },
      implementation: { status: 'completed' },
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const conversations = memoryStateStore(state);
    const monitors = monitorStateStore(monitor);
    const orchestrator = new GitHubNotificationCommentOrchestrator({
      assignmentAuthority: terminalAuthority(true),
      clock: () => 1_755_259_200_000,
      conversationStateStore: conversations,
      initialModeId: 'work',
      lifecycles: lifecycles(),
      logger: { error() {}, info() {}, warn() {} },
      monitorStateStore: monitors,
      publications: { publish: async () => Promise.reject(new Error('unexpected retry')) },
      turnCatalog,
      turns: { respond: async () => Promise.reject(new Error('unexpected turn')) },
    });

    await orchestrator.reconcile(agentId, notificationItemKey);

    assert.equal(
      conversations.snapshot()?.conversations[id]?.deliveryPullRequest?.status,
      'merged',
    );
    const retired = monitors.snapshot().items[notificationItemKey];
    assert.equal(retired?.disposition, 'retired');
    assert.equal(retired?.reasonCode, 'pull-request-merged');
    assert.equal(retired?.intake?.stage, 'retired');
    assert.equal(retired?.intake?.providerRetirementVerifiedAt, 1_755_259_200_000);
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
      monitorStateStore: monitorStateStore(monitor),
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
      source: { itemType: 'issue', number: 12 },
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
      monitorStateStore: monitorStateStore(monitor),
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
      source: { itemType: 'issue', number: 12 },
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
      monitorStateStore: monitorStateStore(monitor),
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
      monitorStateStore: monitorStateStore(monitor),
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
      monitorStateStore: monitorStateStore(monitor),
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
