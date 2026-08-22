import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import GitHubNotificationAssignmentProvider from '../channels/github/intake/assignment-provider.ts';
import type { AgentSystemCliResult } from '../lib/tool-types.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import {
  approvedNotificationItem,
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
    intake: item.intake!,
    item,
    workspaceDir,
  };
}

describe('channels/github/intake/assignment-provider', () => {
  it('should recheck the exact approved assignment from canonical control facts', async () => {
    assert.deepEqual(await provider().inspect(input()), { authorized: true });
  });

  it('should revoke intake when the account is no longer assigned', async () => {
    assert.deepEqual(await provider(false).inspect(input()), {
      authorized: false,
      reasonCode: 'item-unassigned',
    });
  });

  it('should revoke intake before remote access when the exact route drifts', async () => {
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
});
