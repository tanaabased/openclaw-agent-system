import assert from 'node:assert/strict';

import GitHubNotificationAssignmentProvider from '../channels/github/lib/assignment-provider.ts';
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
const manifest: AgentManifest = {
  agent: { id: 'tanaabot' },
  github: {
    notifications: {
      approvedActors: [{ login: notificationActor.login, nodeId: notificationActor.nodeId }],
      intervalMinutes: 5,
      repositoryPolicy: { minimumPermission: 'write' },
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

function provider(assigned = true) {
  return new GitHubNotificationAssignmentProvider({
    accountClient: {
      async connect() {
        return {
          identity: notificationAccount,
          async execute(argv: string[]) {
            const endpoint = argv.find((value) => value.startsWith('/repos/')) ?? '';
            const projection = argv.find((value) => value.includes('htmlUrl:.html_url'));
            if (endpoint.endsWith('/permission')) return response({ permission: 'write' });
            if (endpoint.endsWith('/events')) {
              return response([
                {
                  actor: notificationActor,
                  assignee: notificationAccount,
                  createdAt: '2026-08-11T12:00:00Z',
                  databaseId: 9,
                  event: 'assigned',
                  nodeId: 'EV_assignment',
                },
              ]);
            }
            if (endpoint.endsWith('/issues/12') && projection) {
              return response({
                body: 'Implement assignment delivery.',
                htmlUrl: 'https://github.com/tanaabased/example/issues/12',
                labels: ['feature'],
                milestone: null,
                title: 'Deliver notifications',
              });
            }
            if (endpoint.endsWith('/issues/12')) {
              return response({
                assignees: assigned ? [notificationAccount] : [],
                databaseId: 7,
                isPullRequest: false,
                nodeId: 'I_item',
                number: 12,
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

  it('should load transient briefing data with exact assignment provenance', async () => {
    assert.deepEqual(await provider().briefing(input()), {
      assignmentActor: notificationActor,
      assignmentAt: '2026-08-11T12:00:00Z',
      projection: {
        bodyExcerpt: 'Implement assignment delivery.',
        bodyTruncated: false,
        labels: ['feature'],
        labelsTruncated: false,
        title: 'Deliver notifications',
        url: 'https://github.com/tanaabased/example/issues/12',
      },
    });
  });
});
