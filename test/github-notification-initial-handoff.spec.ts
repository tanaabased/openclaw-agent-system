import assert from 'node:assert/strict';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import {
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
} from '../channels/github/conversation/comment-admission.ts';
import GitHubNotificationCommentOrchestrator from '../channels/github/conversation/comment-orchestrator.ts';
import {
  createGitHubNotificationConversationSnapshot,
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversation,
  type GitHubNotificationConversationSnapshot,
} from '../channels/github/conversation/conversation-state.ts';
import GitHubNotificationPullRequestHandoffService from '../channels/github/conversation/pull-request-handoff-service.ts';
import GitHubNotificationTurnCatalog, {
  githubNotificationSupportedTurnIdentities,
} from '../channels/github/conversation/turn-catalog.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationCommentPublicationService from '../channels/github/publication/comment-publication-service.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import {
  notificationAccount,
  notificationActor,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';
import { createGitHubNotificationTurnDefinitions } from './github-notification-turn-fixtures.ts';
import { resolveTestNotificationRoute } from './openclaw-agent-runtime.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';
const source = { itemType: 'pull-request' as const, number: 45 };

function incomingComment(): GitHubCanonicalIssueComment {
  return {
    author: notificationActor,
    body: '@tanaabot reply from the pull request before handoff',
    bodyTruncated: false,
    createdAt: '2026-08-25T12:01:00.000Z',
    databaseId: 91,
    nodeId: 'IC_before_handoff',
    updatedAt: '2026-08-25T12:01:00.000Z',
  };
}

async function handoffFixture() {
  const monitor = notificationMonitorState();
  monitor.agentId = agentId;
  monitor.workspaceDir = workspaceDir;
  const item = monitor.items[notificationItemKey]!;
  item.intake = { ...item.intake!, stage: 'prepared' };
  const conversationId = githubNotificationConversationId({
    itemNumber: item.number,
    lifecycleId: item.lifecycleId,
    repositoryId: item.repositoryNodeId,
  });
  let snapshot = createGitHubNotificationConversationSnapshot(
    agentId,
    workspaceDir,
    conversationId,
  );
  snapshot.conversation = {
    baselineEstablished: true,
    implementation: { status: 'delivery-pending' },
    itemKey: notificationItemKey,
    lifecycleId: 'issue',
    mode: 'work',
    revisions: {},
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
    channels: { [githubNotificationChannelId]: { accounts: { [agentId]: { enabled: true } } } },
  };
  const controls: {
    fail?: 'baseline' | 'event' | 'handoff-checkpoint' | 'handoff' | 'reply-receipt';
    state: 'closed' | 'open';
  } = { state: 'open' };
  function interrupt(phase: typeof controls.fail) {
    if (controls.fail !== phase) return;
    delete controls.fail;
    throw new Error(`controlled ${phase} failure`);
  }
  const store = {
    async read(selectedAgentId: string, selectedConversationId: string) {
      assert.equal(selectedAgentId, agentId);
      assert.equal(selectedConversationId, conversationId);
      return structuredClone(snapshot);
    },
    async write(next: GitHubNotificationConversationSnapshot) {
      if (next.conversation?.deliveryPullRequest?.handoff?.status === 'pending') {
        interrupt('handoff-checkpoint');
      }
      if (
        Object.values(next.conversation?.revisions ?? {}).some(
          (revision) => revision.publication?.status === 'published',
        )
      ) {
        interrupt('reply-receipt');
      }
      snapshot = structuredClone(next);
    },
  };
  const comments: GitHubCanonicalIssueComment[] = [];
  const replies: Array<{ body: string; databaseId: number; nodeId: string; number: number }> = [];
  const counts = { comments: 0, handoffs: 0, replies: 0 };
  const authority = {
    async open() {
      return {
        authorized: true as const,
        client: {
          identity: notificationAccount,
          async listIssueComments(_owner: string, _repository: string, number: number) {
            if (number === source.number) interrupt('baseline');
            return {
              comments: number === source.number ? structuredClone(comments) : [],
              truncated: false,
            };
          },
          async getIssueComment(
            _owner: string,
            _repository: string,
            number: number,
            databaseId: number,
          ) {
            assert.equal(number, source.number);
            const comment = comments.find((entry) => entry.databaseId === databaseId);
            assert.ok(comment);
            return structuredClone(comment);
          },
          async getItem() {
            return {
              assignees: [],
              databaseId: 145,
              itemType: 'pull-request' as const,
              nodeId: 'PR_delivery',
              number: source.number,
              pullRequest: {
                baseRef: 'main',
                baseRepositoryDatabaseId: 3,
                baseRepositoryNodeId: 'R_repo',
                draft: true,
                headRef: 'issue-12',
                headRepositoryDatabaseId: 3,
                headRepositoryNodeId: 'R_repo',
                headSha: 'a'.repeat(40),
                merged: false,
              },
              state: controls.state,
              updatedAt: '2026-08-25T12:00:00.000Z',
            };
          },
          async createIssueComment(
            _owner: string,
            _repository: string,
            number: number,
            body: string,
          ) {
            assert.equal(number, source.number);
            counts.replies += 1;
            const reply = {
              body,
              databaseId: 102 + counts.replies,
              nodeId: `IC_reply_${counts.replies}`,
              number,
            };
            replies.push(reply);
            return reply;
          },
          async findOwnIssueComment(
            _owner: string,
            _repository: string,
            number: number,
            marker: string,
          ) {
            assert.equal(number, source.number);
            return replies.find((reply) => reply.number === number && reply.body.includes(marker));
          },
        },
        configuration: {
          approvedActors: [notificationActor],
          assignmentTypes: ['issue' as const],
          intervalMinutes: 5,
        },
      };
    },
  };
  const lifecycle = new GitHubIssueLifecycle({
    cleanupGitHub: async () => ({ status: 'missing' }),
    inspectGitHub: async () => undefined,
    prepareGitHub: async () => {
      throw new Error('unexpected preparation');
    },
  });
  const logger = { error() {}, info() {}, warn() {} };
  const handoff = new GitHubNotificationPullRequestHandoffService({
    assignmentAuthority: authority,
    conversationStateStore: store,
    coordinator: {
      async run() {
        interrupt('event');
        counts.handoffs += 1;
        return {
          dispatch: { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false },
          finalPayloadCount: 1,
          privateText: 'The delivery pull request is linked.',
          publication: { status: 'none' },
        };
      },
    },
    logger,
    publications: {
      async publish(input) {
        interrupt('handoff');
        return {
          receipt: { databaseId: 101, nodeId: 'IC_handoff' },
          status: 'published',
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
  const orchestrator = new GitHubNotificationCommentOrchestrator({
    assignmentAuthority: authority,
    conversationStateStore: store,
    initialModeId: 'work',
    lifecycles: { resolve: () => lifecycle },
    logger,
    monitorStateStore: {
      read: async () => structuredClone(monitor),
      update: async () => {
        throw new Error('unexpected monitor mutation');
      },
    },
    publications: new GitHubNotificationCommentPublicationService({
      assignmentAuthority: authority,
      conversationStateStore: store,
      manifestService: {
        async loadForAgentId() {
          return {
            diagnostics: [],
            digest: 'digest',
            manifest: {
              agent: { id: agentId },
              github: { notifications: (await authority.open()).configuration, username: agentId },
              schemaVersion: 1,
            },
            path: `${workspaceDir}/agent.yaml`,
            scope: { agentId, workspaceDir },
            status: 'loaded',
            validationChecks: [],
          };
        },
      },
      monitorStateStore: { read: async () => structuredClone(monitor) },
      publicationLeaseStore: { exclusive: async (_agent, _target, _signal, run) => run() },
      readConfig: () => config,
      resolveNotificationRoute: resolveTestNotificationRoute,
    }),
    turnCatalog: new GitHubNotificationTurnCatalog(
      githubNotificationSupportedTurnIdentities,
      createGitHubNotificationTurnDefinitions(),
    ),
    turns: {
      async respond(input) {
        counts.comments += 1;
        assert.equal(input.item.number, item.number);
        assert.deepEqual(input.source, source);
        assert.deepEqual(snapshot.conversation?.activeTurn, {
          eventId: 'comment',
          sourceId: githubCommentRevision(input.comment).revisionId,
        });
        return {
          agentId,
          privateText: 'Ready.',
          publication: { status: 'candidate', publicText: 'ready on the pull request' },
        };
      },
    },
  });
  const input = {
    agentId,
    executionSurface: 'cli-one-shot' as const,
    item,
    lifecycle,
    workspaceDir,
  };
  await handoff.checkpoint({
    ...input,
    pullRequest: { pullRequestNodeId: 'PR_delivery', pullRequestNumber: source.number },
  });
  snapshot.conversation!.implementation = { status: 'completed' };
  return {
    comments,
    controls,
    counts,
    replies,
    reconcileComments: () => orchestrator.reconcile(agentId, notificationItemKey),
    reconcileHandoff: () => handoff.reconcile(input),
    snapshot: () => structuredClone(snapshot),
    updateConversation: (update: (conversation: GitHubNotificationConversation) => void) =>
      update(snapshot.conversation!),
  };
}

describe('channels/github/conversation initial handoff', () => {
  it('should deliver an approved pre-handoff pull request comment exactly once', async () => {
    const fixture = await handoffFixture();
    const comment = incomingComment();
    fixture.comments.push(comment);

    await fixture.reconcileHandoff();
    await fixture.reconcileComments();

    assert.equal(
      fixture.counts.comments,
      1,
      `pre-handoff comment was dropped as ${fixture.snapshot().conversation?.revisions[comment.nodeId]?.status}`,
    );
    assert.equal(fixture.counts.replies, 1);
    await fixture.reconcileHandoff();
    await fixture.reconcileComments();
    assert.deepEqual(fixture.counts, { comments: 1, handoffs: 1, replies: 1 });
    const revision = fixture.snapshot().conversation?.revisions[comment.nodeId];
    assert.equal(revision?.status, 'responded');
    assert.equal(revision?.publication?.status, 'published');
    assert.deepEqual(revision?.source, source);
    assert.deepEqual(
      fixture.replies.map(({ number }) => number),
      [source.number],
    );
  });

  for (const phase of ['baseline', 'event', 'handoff-checkpoint', 'handoff'] as const) {
    it(`should defer comment reconciliation until an interrupted ${phase} completes`, async () => {
      const fixture = await handoffFixture();
      const comment = incomingComment();
      fixture.comments.push(comment);
      fixture.controls.fail = phase;

      await assert.rejects(fixture.reconcileHandoff());
      const interrupted = fixture.snapshot();
      await fixture.reconcileComments();
      assert.deepEqual(fixture.snapshot(), interrupted);
      assert.equal(fixture.counts.comments, 0);
      assert.equal(fixture.snapshot().conversation?.revisions[comment.nodeId], undefined);

      await fixture.reconcileHandoff();
      await fixture.reconcileComments();
      await fixture.reconcileComments();
      assert.deepEqual(fixture.counts, { comments: 1, handoffs: 1, replies: 1 });
    });
  }

  it('should leave a checkpointed source untouched before implementation completion is persisted', async () => {
    const fixture = await handoffFixture();
    fixture.comments.push(incomingComment());
    fixture.updateConversation((conversation) => {
      conversation.implementation = { status: 'delivery-pending' };
    });
    const checkpoint = fixture.snapshot();
    await fixture.reconcileComments();
    assert.deepEqual(fixture.snapshot(), checkpoint);
    assert.equal(fixture.counts.comments, 0);
    fixture.updateConversation((conversation) => {
      conversation.implementation = { status: 'completed' };
    });
    await fixture.reconcileHandoff();
    await fixture.reconcileComments();
    assert.equal(fixture.counts.comments, 1);
  });

  for (const status of ['admitted', 'baseline', 'rejected', 'responded'] as const) {
    it(`should preserve an existing ${status} revision during initial handoff`, async () => {
      const fixture = await handoffFixture();
      const comment = incomingComment();
      fixture.comments.push(comment);
      fixture.updateConversation((conversation) => {
        conversation.revisions[comment.nodeId] = {
          ...githubCommentRevision(comment),
          commentDatabaseId: comment.databaseId,
          reasonCode: status === 'baseline' ? 'comment-baseline' : 'comment-approved',
          source,
          status,
          ...(status === 'responded'
            ? {
                publication: {
                  commentDatabaseId: 90,
                  commentNodeId: 'IC_existing_reply',
                  publicText: 'already answered',
                  publicTextDigest: githubNotificationPublicTextDigest('already answered'),
                  status: 'published' as const,
                  target: githubNotificationPublicationTarget({
                    conversationId: fixture.snapshot().conversationId,
                    intent: 'github-reply',
                    source: {
                      commentDatabaseId: comment.databaseId,
                      revisionId: githubCommentRevision(comment).revisionId,
                    },
                  }),
                },
              }
            : {}),
        };
      });
      const receipt = fixture.snapshot().conversation!.revisions[comment.nodeId];
      await fixture.reconcileHandoff();
      assert.deepEqual(fixture.snapshot().conversation!.revisions[comment.nodeId], receipt);
      await fixture.reconcileComments();
      await fixture.reconcileComments();
      assert.equal(fixture.counts.comments, status === 'admitted' ? 1 : 0);
      assert.equal(fixture.counts.replies, status === 'admitted' ? 1 : 0);
    });
  }

  it('should retain an older receipt and admit a newly eligible edited revision after handoff', async () => {
    const fixture = await handoffFixture();
    const oldComment = { ...incomingComment(), body: 'historical text' };
    const previous = {
      ...githubCommentRevision(oldComment),
      commentDatabaseId: oldComment.databaseId,
      reasonCode: 'comment-baseline',
      source,
      status: 'baseline' as const,
    };
    fixture.updateConversation((conversation) => {
      conversation.revisions[oldComment.nodeId] = previous;
    });
    fixture.comments.push({ ...incomingComment(), updatedAt: '2026-08-25T12:02:00.000Z' });
    await fixture.reconcileHandoff();
    assert.deepEqual(fixture.snapshot().conversation?.revisions[oldComment.nodeId], previous);
    await fixture.reconcileComments();
    await fixture.reconcileComments();
    assert.equal(fixture.counts.comments, 1);
    assert.equal(fixture.counts.replies, 1);
  });

  it('should baseline ineligible comments without replaying them after handoff', async () => {
    const fixture = await handoffFixture();
    const base = incomingComment();
    const ineligible = [
      { ...base, author: { ...notificationActor, nodeId: 'U_unapproved' } },
      { ...base, author: notificationAccount },
      { ...base, body: '> @tanaabot quoted mention' },
      { ...base, body: 'no mention here' },
      { ...base, bodyTruncated: true },
    ].map((comment, index) => ({
      ...comment,
      nodeId: `IC_ineligible_${index}`,
      databaseId: 200 + index,
    }));
    fixture.comments.push(...ineligible);
    await fixture.reconcileHandoff();
    await fixture.reconcileComments();
    for (const comment of ineligible) {
      assert.equal(fixture.snapshot().conversation?.revisions[comment.nodeId]?.status, 'baseline');
    }
    assert.equal(fixture.counts.comments, 0);
    assert.equal(fixture.counts.replies, 0);
  });

  it('should reconcile a published reply after an interrupted receipt without another model turn', async () => {
    const fixture = await handoffFixture();
    fixture.comments.push(incomingComment());
    await fixture.reconcileHandoff();
    fixture.controls.fail = 'reply-receipt';
    await assert.rejects(fixture.reconcileComments());
    assert.equal(
      fixture.snapshot().conversation?.revisions.IC_before_handoff?.publication?.status,
      'pending',
    );
    await fixture.reconcileHandoff();
    await fixture.reconcileComments();
    await fixture.reconcileComments();
    assert.deepEqual(fixture.counts, { comments: 1, handoffs: 1, replies: 1 });
    assert.equal(
      fixture.snapshot().conversation?.revisions.IC_before_handoff?.publication?.status,
      'published',
    );
  });

  for (const baselineOwner of ['handoff', 'comments'] as const) {
    it(`should preserve fresh reopen baselines through ${baselineOwner} reconciliation`, async () => {
      const fixture = await handoffFixture();
      await fixture.reconcileHandoff();
      fixture.controls.state = 'closed';
      await fixture.reconcileComments();
      fixture.comments.push(incomingComment());
      fixture.controls.state = 'open';
      await fixture.reconcileComments();
      if (baselineOwner === 'handoff') await fixture.reconcileHandoff();
      else await fixture.reconcileComments();
      await fixture.reconcileComments();
      assert.equal(
        fixture.snapshot().conversation?.revisions.IC_before_handoff?.status,
        'baseline',
      );
      assert.equal(fixture.counts.comments, 0);

      fixture.comments.push({ ...incomingComment(), nodeId: 'IC_after_reopen', databaseId: 92 });
      await fixture.reconcileComments();
      await fixture.reconcileComments();
      assert.deepEqual(fixture.counts, { comments: 1, handoffs: 1, replies: 1 });
    });
  }
});
