import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import GitHubNotificationAssignmentProvider from '../channels/github/lib/assignment-provider.ts';
import { githubCommentRevision } from '../channels/github/utils/comment-admission.ts';
import type { AgentSystemCliResult } from '../lib/tool-types.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import {
  approvedNotificationItem,
  approvedPullRequestNotificationItem,
  notificationAccount,
  notificationActor,
  notificationOwner,
  notificationRepository,
} from './github-notification-fixtures.ts';

const workspaceDir = '/workspace';
const config: OpenClawConfig = {
  agents: { list: [{ id: 'tanaabot', workspace: workspaceDir }] },
  bindings: [
    {
      agentId: 'tanaabot',
      match: { accountId: 'tanaabot', channel: 'agent-system-github' },
      session: { dmScope: 'per-account-channel-peer' },
      type: 'route',
    },
  ],
  channels: {
    'agent-system-github': { accounts: { tanaabot: { enabled: true } } },
  },
};
const manifest: AgentManifest = {
  agent: { id: 'tanaabot' },
  github: {
    notifications: {
      assignmentTypes: ['issue', 'pull-request'],
      approvedActors: [{ login: notificationActor.login, nodeId: notificationActor.nodeId }],
      intervalMinutes: 5,
    },
    token: 'GH_TOKEN_TANAABOT',
    username: notificationAccount.login,
  },
  schemaVersion: 1,
};

function response(body: unknown): AgentSystemCliResult {
  return {
    exitCode: 0,
    stderr: '',
    stdout: ['HTTP/2 200 OK', 'x-ratelimit-remaining: 100', '', JSON.stringify(body)].join('\n'),
    timedOut: false,
    truncated: false,
  };
}

function provider(
  assigned = true,
  routeReady = true,
  onConnect = () => undefined,
  commentBody = '@tanaabot status?',
  pullRequest = false,
) {
  const itemNumber = pullRequest ? 13 : 12;
  return new GitHubNotificationAssignmentProvider({
    accountClient: {
      async connect() {
        onConnect();
        return {
          identity: notificationAccount,
          async execute(argv: string[]) {
            const endpoint = argv.find((value) => value.startsWith('/repos/')) ?? '';
            if (endpoint.endsWith('/permission')) return response({ permission: 'write' });
            if (endpoint.endsWith('/issues/comments/91')) {
              return response({
                author: notificationActor,
                body: commentBody,
                bodyLength: commentBody.length,
                createdAt: '2026-08-14T12:00:00.000Z',
                databaseId: 91,
                issueUrl: `https://api.github.com/repos/tanaabased/example/issues/${itemNumber}`,
                nodeId: 'IC_comment',
                updatedAt: '2026-08-14T12:00:00.000Z',
              });
            }
            if (endpoint.endsWith('/comments')) return response([]);
            if (endpoint.endsWith('/events')) {
              return response([
                {
                  actor: notificationActor,
                  assignee: notificationAccount,
                  createdAt: '2026-08-11T12:00:00Z',
                  databaseId: 9,
                  event: 'assigned',
                  nodeId: pullRequest ? 'EV_pull_request_assignment' : 'EV_assignment',
                },
              ]);
            }
            if (endpoint.endsWith(`/pulls/${itemNumber}/files`)) return response([]);
            if (endpoint.endsWith(`/pulls/${itemNumber}`)) {
              return response({
                author: notificationActor,
                base: {
                  ref: 'main',
                  repository: {
                    databaseId: notificationRepository.databaseId,
                    nodeId: notificationRepository.nodeId,
                  },
                },
                draft: false,
                head: {
                  ref: 'notification-pr',
                  repository: {
                    databaseId: notificationRepository.databaseId,
                    nodeId: notificationRepository.nodeId,
                  },
                  sha: 'b'.repeat(40),
                },
                merged: false,
              });
            }
            if (endpoint.endsWith(`/issues/${itemNumber}`)) {
              if (argv.some((value) => value.includes('commentCount:.comments'))) {
                return response({
                  body: pullRequest
                    ? 'Please review this safely.'
                    : 'Please implement this safely.',
                  commentCount: 0,
                  labels: [pullRequest ? 'review' : 'feature'],
                  title: pullRequest
                    ? 'Review notification planning'
                    : 'Implement notification planning',
                });
              }
              return response({
                assignees: assigned ? [notificationAccount] : [],
                databaseId: pullRequest ? 8 : 7,
                isPullRequest: pullRequest,
                nodeId: pullRequest ? 'PR_item' : 'I_item',
                number: itemNumber,
                state: 'open',
                updatedAt: '2026-08-11T12:00:00Z',
              });
            }
            return response({
              archived: false,
              cloneUrl: notificationRepository.cloneUrl,
              databaseId: notificationRepository.databaseId,
              defaultBranch: notificationRepository.defaultBranch,
              disabled: false,
              name: notificationRepository.name,
              nodeId: notificationRepository.nodeId,
              owner: notificationOwner,
            });
          },
        };
      },
    },
    manifestService: {
      async loadForAgentId() {
        return {
          diagnostics: [],
          digest: 'digest',
          manifest,
          path: `${workspaceDir}/agent.yaml`,
          scope: { agentId: 'tanaabot', workspaceDir },
          status: 'loaded' as const,
          validationChecks: [],
        };
      },
    },
    readConfig: () => (routeReady ? config : { ...config, bindings: [] }),
  });
}

function input() {
  const item = approvedNotificationItem();
  return {
    agentId: 'tanaabot',
    delivery: item.delivery!,
    item,
    workspaceDir,
  };
}

function pullRequestInput() {
  const item = approvedPullRequestNotificationItem();
  return {
    agentId: 'tanaabot',
    delivery: item.delivery!,
    item,
    workspaceDir,
  };
}

describe('channels/github/lib/assignment-provider', () => {
  it('should recheck the exact approved assignment from canonical control facts', async () => {
    assert.deepEqual(await provider().inspect(input()), { authorized: true });
  });

  it('should revoke delivery when the account is no longer assigned', async () => {
    assert.deepEqual(await provider(false).inspect(input()), {
      authorized: false,
      reasonCode: 'item-unassigned',
    });
  });

  it('should revoke delivery before remote access when the exact route drifts', async () => {
    let connections = 0;
    assert.deepEqual(
      await provider(true, false, () => {
        connections += 1;
      }).inspect(input()),
      {
        authorized: false,
        reasonCode: 'github-notification-route-revoked',
      },
    );
    assert.equal(connections, 0);
  });

  it('should return bounded planning prose only after authority succeeds', async () => {
    const result = await provider().loadPlanningContext(input());

    assert.deepEqual(result, {
      authorized: true,
      context: {
        body: 'Please implement this safely.',
        comments: [],
        labels: ['feature'],
        title: 'Implement notification planning',
        truncated: false,
      },
    });
  });

  it('should authorize direct pull-request planning from stable identity facts', async () => {
    const result = await provider(
      true,
      true,
      () => undefined,
      '@tanaabot status?',
      true,
    ).loadPlanningContext(pullRequestInput());

    assert.deepEqual(result, {
      authorized: true,
      context: {
        body: 'Please review this safely.',
        comments: [],
        files: [],
        labels: ['review'],
        title: 'Review notification planning',
        truncated: false,
      },
    });
  });

  it('should authorize only the exact current admitted comment revision', async () => {
    const context = {
      author: notificationActor,
      body: '@tanaabot status?',
      bodyTruncated: false,
      createdAt: '2026-08-14T12:00:00.000Z',
      databaseId: 91,
      nodeId: 'IC_comment',
      updatedAt: '2026-08-14T12:00:00.000Z',
    };
    const revision = githubCommentRevision(context);
    const commentInput = {
      ...input(),
      comment: {
        actorNodeId: notificationActor.nodeId,
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: context.databaseId,
        commentNodeId: context.nodeId,
        createdAt: Date.parse(context.createdAt),
        disposition: 'approved' as const,
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        turn: { status: 'pending' as const },
        updatedAt: Date.parse(context.updatedAt),
      },
    };

    assert.deepEqual(await provider().loadCommentContext(commentInput), {
      authorized: true,
      context,
    });
    assert.deepEqual(
      await provider(true, true, () => undefined, 'mention removed').inspectComment(commentInput),
      {
        authorized: false,
        reasonCode: 'github-notification-comment-revision-stale',
      },
    );
  });

  it('should reauthorize an admitted pull-request top-level comment', async () => {
    const context = {
      author: notificationActor,
      body: '@tanaabot status?',
      bodyTruncated: false,
      createdAt: '2026-08-14T12:00:00.000Z',
      databaseId: 91,
      nodeId: 'IC_comment',
      updatedAt: '2026-08-14T12:00:00.000Z',
    };
    const revision = githubCommentRevision(context);
    const commentInput = {
      ...pullRequestInput(),
      comment: {
        actorNodeId: notificationActor.nodeId,
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: context.databaseId,
        commentNodeId: context.nodeId,
        createdAt: Date.parse(context.createdAt),
        disposition: 'approved' as const,
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        turn: { status: 'pending' as const },
        updatedAt: Date.parse(context.updatedAt),
      },
    };

    assert.deepEqual(
      await provider(true, true, () => undefined, context.body, true).loadCommentContext(
        commentInput,
      ),
      { authorized: true, context },
    );
  });
});
