import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import type { GitHubNotificationAssignmentInspection } from '../channels/github/intake/assignment-provider.ts';
import GitHubNotificationCommentPublicationService, {
  GitHubNotificationCommentPublicationServiceError,
} from '../channels/github/publication/comment-publication-service.ts';
import type GitHubWorkEventClient from '../channels/github/provider/work-event-client.ts';
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
const publicText = 'ready';
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

describe('channels/github/publication/comment-publication-service', () => {
  it('should reauthorize the exact source revision before publishing accepted text', async () => {
    const fixture = stateFixture();
    let opened = 0;
    let publishedBody = '';
    const client = {
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
    } as unknown as GitHubWorkEventClient;
    const service = new GitHubNotificationCommentPublicationService({
      assignmentAuthority: {
        async open(): Promise<GitHubNotificationAssignmentInspection> {
          opened += 1;
          return { authorized: true, client, configuration };
        },
      },
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

    const result = await service.publish({
      accountId: agentId,
      target: fixture.target,
      text: publicText,
    });

    assert.equal(opened, 1);
    assert.equal(result.status, 'published');
    assert.match(publishedBody, /^ready\n\n<!-- agent-system-github-publication:github-reply:/u);
  });

  it('should reject unaccepted text before connecting credentials', async () => {
    const fixture = stateFixture();
    let opened = 0;
    const service = new GitHubNotificationCommentPublicationService({
      assignmentAuthority: {
        async open() {
          opened += 1;
          return { authorized: false } as const;
        },
      },
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

    await assert.rejects(
      service.publish({ accountId: agentId, target: fixture.target, text: 'different' }),
      (error: unknown) =>
        error instanceof GitHubNotificationCommentPublicationServiceError &&
        error.code === 'github-notification-publication-target-not-admitted',
    );
    assert.equal(opened, 0);
  });
});
