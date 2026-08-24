import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import type {
  GitHubNotificationAssignmentInspection,
  GitHubNotificationAssignmentProviderAuthority,
} from '../channels/github/intake/assignment-provider.ts';
import GitHubNotificationCommentPublicationService, {
  GitHubNotificationCommentPublicationServiceError,
} from '../channels/github/publication/comment-publication-service.ts';
import type { GitHubNotificationPublicationClient } from '../channels/github/provider/work-event-client.ts';
import {
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
} from '../channels/github/conversation/comment-admission.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
} from '../channels/github/conversation/conversation-state.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import type { AgentManifest } from '../manifest/types.ts';
import {
  notificationAccount,
  notificationActor,
  notificationItemKey,
  notificationMonitorState,
} from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';
const publicText = 'Ready for you, {{commenter}}.';
const configuration = {
  assignmentTypes: ['issue', 'pull-request'] as Array<'issue' | 'pull-request'>,
  approvedActors: [{ login: notificationActor.login, nodeId: notificationActor.nodeId }],
  intervalMinutes: 5,
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
const manifest: AgentManifest = {
  agent: { id: agentId },
  github: {
    notifications: configuration,
    token: 'GH_TOKEN_TANAABOT',
    username: agentId,
  },
  schemaVersion: 1,
};

type PublicationClient = GitHubNotificationPublicationClient;

function sourceComment(): GitHubCanonicalIssueComment {
  return {
    author: notificationActor,
    body: '@tanaabot reply with ready',
    bodyTruncated: false,
    createdAt: '2026-08-15T12:00:00.000Z',
    databaseId: 91,
    nodeId: 'IC_source',
    updatedAt: '2026-08-15T12:00:00.000Z',
  };
}

function stateFixture() {
  const comment = sourceComment();
  const revision = githubCommentRevision(comment);
  const monitor = notificationMonitorState();
  monitor.agentId = agentId;
  monitor.workspaceDir = workspaceDir;
  const item = monitor.items[notificationItemKey]!;
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
  const target = githubNotificationPublicationTarget({
    intent: 'github-reply',
    item,
    source: { commentDatabaseId: comment.databaseId, revisionId: revision.revisionId },
  });
  const conversations = createGitHubNotificationConversationState(agentId, workspaceDir);
  conversations.conversations[conversationId] = {
    baselineEstablished: true,
    itemKey: notificationItemKey,
    lifecycleId: 'issue',
    mode: 'work',
    revisions: {
      [comment.nodeId]: {
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: comment.databaseId,
        publication: {
          publicText,
          publicTextDigest: githubNotificationPublicTextDigest(publicText),
          status: 'pending',
          target,
        },
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        status: 'responded',
      },
    },
  };
  return { comment, conversations, monitor, target };
}

function acknowledgmentFixture() {
  const monitor = notificationMonitorState();
  monitor.agentId = agentId;
  monitor.workspaceDir = workspaceDir;
  const item = monitor.items[notificationItemKey]!;
  const conversationId = githubNotificationConversationId({
    itemNumber: item.number,
    lifecycleId: item.lifecycleId,
    repositoryId: item.repositoryNodeId,
  });
  const publicText = "Got it — I'm starting on this now.";
  const target = githubNotificationPublicationTarget({
    intent: 'initial-acknowledgment',
    item,
    publicationId: item.intake!.assignmentEventId,
  });
  const conversations = createGitHubNotificationConversationState(agentId, workspaceDir);
  conversations.conversations[conversationId] = {
    acknowledgment: {
      publicText,
      publicTextDigest: githubNotificationPublicTextDigest(publicText),
      status: 'pending',
      target,
    },
    baselineEstablished: false,
    itemKey: notificationItemKey,
    lifecycleId: 'issue',
    mode: 'work',
    revisions: {},
  };
  return { conversations, monitor, publicText, target };
}

function assignmentResponseFixture() {
  const monitor = notificationMonitorState();
  monitor.agentId = agentId;
  monitor.workspaceDir = workspaceDir;
  const item = monitor.items[notificationItemKey]!;
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
  const publicText = 'I reviewed the assignment and have a plan ready.';
  const target = githubNotificationPublicationTarget({
    intent: 'assignment-response',
    item,
    publicationId: item.intake.assignmentEventId,
  });
  const conversations = createGitHubNotificationConversationState(agentId, workspaceDir);
  conversations.conversations[conversationId] = {
    assignmentResponse: {
      publicText,
      publicTextDigest: githubNotificationPublicTextDigest(publicText),
      status: 'pending',
      target,
    },
    baselineEstablished: false,
    itemKey: notificationItemKey,
    lifecycleId: 'issue',
    mode: 'work',
    revisions: {},
  };
  return { conversations, monitor, publicText, target };
}

function publicationService(
  fixture: {
    conversations: ReturnType<typeof createGitHubNotificationConversationState>;
    monitor: ReturnType<typeof notificationMonitorState>;
  },
  assignmentAuthority: GitHubNotificationAssignmentProviderAuthority<PublicationClient>,
) {
  return new GitHubNotificationCommentPublicationService({
    assignmentAuthority,
    conversationStateStore: { read: async () => structuredClone(fixture.conversations) },
    manifestService: {
      async loadForAgentId() {
        return {
          diagnostics: [],
          digest: 'digest',
          manifest,
          path: `${workspaceDir}/agent.yaml`,
          scope: { agentId, workspaceDir },
          status: 'loaded' as const,
          validationChecks: [],
        };
      },
    },
    monitorStateStore: { read: async () => structuredClone(fixture.monitor) },
    publicationLeaseStore: { exclusive: async (_agent, _target, _signal, run) => run() },
    readConfig: async () => config,
  });
}

describe('channels/github/publication/comment-publication-service', () => {
  it('should reauthorize the exact source revision before publishing accepted text', async () => {
    const fixture = stateFixture();
    let opened = 0;
    let publishedBody = '';
    const client: PublicationClient = {
      identity: notificationAccount,
      async createIssueComment(_owner: string, _repository: string, _number: number, body: string) {
        publishedBody = body;
        return { databaseId: 101, nodeId: 'IC_reply' };
      },
      async findOwnIssueComment() {
        return undefined;
      },
      async getIssueComment() {
        return structuredClone(fixture.comment);
      },
    };
    const service = publicationService(fixture, {
      async open(): Promise<GitHubNotificationAssignmentInspection<PublicationClient>> {
        opened += 1;
        return { authorized: true, client, configuration };
      },
    });

    const result = await service.publish({
      accountId: agentId,
      target: fixture.target,
      text: publicText,
    });

    assert.equal(opened, 1);
    assert.equal(result.status, 'published');
    assert.match(
      publishedBody,
      /^Ready for you, @pirog\.\n\n<!-- agent-system-github-publication:github-reply:/u,
    );
  });

  it('should reject unaccepted text before connecting credentials', async () => {
    const fixture = stateFixture();
    let opened = 0;
    const service = publicationService(fixture, {
      async open() {
        opened += 1;
        return { authorized: false } as const;
      },
    });

    await assert.rejects(
      service.publish({ accountId: agentId, target: fixture.target, text: 'different' }),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentPublicationServiceError &&
        error.code === 'github-notification-publication-target-not-admitted',
    );
    assert.equal(opened, 0);
  });

  it('should reauthorize the assignment before publishing its acknowledgment', async () => {
    const fixture = acknowledgmentFixture();
    let publishedBody = '';
    const client: PublicationClient = {
      identity: notificationAccount,
      async createIssueComment(_owner: string, _repository: string, _number: number, body: string) {
        publishedBody = body;
        return { databaseId: 101, nodeId: 'IC_acknowledgment' };
      },
      async findOwnIssueComment() {
        return undefined;
      },
      async getIssueComment() {
        throw new Error('not used for assignment acknowledgments');
      },
    };
    const service = publicationService(fixture, {
      async open(): Promise<GitHubNotificationAssignmentInspection<PublicationClient>> {
        return { authorized: true, client, configuration };
      },
    });

    const result = await service.publish({
      accountId: agentId,
      target: fixture.target,
      text: fixture.publicText,
    });

    assert.equal(result.status, 'published');
    assert.match(publishedBody, /^Got it — I'm starting on this now\./u);
    assert.match(publishedBody, /<!-- agent-system-github-publication:initial-acknowledgment:/u);
    assert.doesNotMatch(publishedBody, /^@/u);
  });

  it('should reauthorize the assignment before publishing its response', async () => {
    const fixture = assignmentResponseFixture();
    let publishedBody = '';
    const client: PublicationClient = {
      identity: notificationAccount,
      async createIssueComment(_owner: string, _repository: string, _number: number, body: string) {
        publishedBody = body;
        return { databaseId: 101, nodeId: 'IC_assignment_response' };
      },
      async findOwnIssueComment() {
        return undefined;
      },
      async getIssueComment() {
        throw new Error('not used for assignment responses');
      },
    };
    const service = publicationService(fixture, {
      async open(): Promise<GitHubNotificationAssignmentInspection<PublicationClient>> {
        return { authorized: true, client, configuration };
      },
    });

    const result = await service.publish({
      accountId: agentId,
      target: fixture.target,
      text: fixture.publicText,
    });

    assert.equal(result.status, 'published');
    assert.match(publishedBody, /^I reviewed the assignment and have a plan ready\./u);
    assert.match(publishedBody, /<!-- agent-system-github-publication:assignment-response:/u);
    assert.doesNotMatch(publishedBody, /^@/u);
  });
});
