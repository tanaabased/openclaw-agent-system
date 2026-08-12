import assert from 'node:assert/strict';

import {
  GitHubNotificationPollError,
  pollGitHubNotifications,
} from '../channels/github/lib/poller.ts';
import {
  GitHubWorkEventClientError,
  type default as GitHubWorkEventClient,
} from '../channels/github/lib/work-event-client.ts';
import type { GitHubRepositoryPermission } from '../channels/github/utils/work-item.ts';
import {
  notificationAccount as account,
  notificationActor as actor,
  notificationRepository as repository,
} from './github-notification-fixtures.ts';

const baselineAt = Date.parse('2026-08-11T12:00:00.000Z');
const candidate = {
  databaseId: 7,
  itemType: 'issue' as const,
  nodeId: 'I_item',
  number: 12,
  repositoryPath: '/repos/tanaabased/example',
  updatedAt: '2026-08-11T12:05:00.000Z',
};
const item = {
  assignees: [account],
  databaseId: candidate.databaseId,
  itemType: 'issue' as const,
  nodeId: candidate.nodeId,
  number: candidate.number,
  state: 'open' as const,
  updatedAt: candidate.updatedAt,
};
const assignment = {
  actor,
  assignee: account,
  createdAt: '2026-08-11T12:04:00.000Z',
  databaseId: 9,
  event: 'assigned' as const,
  nodeId: 'EV_assignment',
};
const configuration = {
  approvedActors: [{ login: actor.login, nodeId: actor.nodeId }],
  intervalMinutes: 5,
  repositoryPolicy: {
    allowedOwners: [{ login: repository.owner.login, nodeId: repository.owner.nodeId }],
    minimumPermission: 'write' as const,
  },
};

function client(
  options: {
    assigned?: boolean;
    candidates?: (typeof candidate)[];
    identity?: typeof account;
    permission?: GitHubRepositoryPermission;
    repository?: typeof repository;
    resourceMissing?: boolean;
    truncated?: boolean;
  } = {},
) {
  const clientIdentity = options.identity ?? account;
  return {
    identity: clientIdentity,
    rateLimit: {},
    async discoverAssigned() {
      const candidates = options.candidates ?? [];
      return {
        candidates,
        incomplete: false,
        totalCount: candidates.length,
        truncated: options.truncated ?? false,
      };
    },
    async getRepository() {
      if (options.resourceMissing) {
        throw new GitHubWorkEventClientError('github-notification-resource-missing', 'missing');
      }
      return options.repository ?? repository;
    },
    async getPermission() {
      return options.permission ?? ('write' as const);
    },
    async getItem() {
      return {
        ...item,
        assignees: options.assigned === false ? [] : item.assignees,
      };
    },
    async listAssignmentEvents() {
      return { events: [assignment], truncated: false };
    },
  } as unknown as GitHubWorkEventClient;
}

describe('channels/github/lib/poller', () => {
  it('should establish a first baseline without approving existing assignments', async () => {
    const result = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ candidates: [candidate] }),
      configuration,
      now: baselineAt,
      workspaceDir: '/workspace',
    });

    assert.equal(result.baseline, 1);
    assert.equal(result.approved, 0);
    assert.deepEqual(result.state.baselineItemNodeIds, [candidate.nodeId]);
    assert.deepEqual(result.state.items, {});
  });

  it('should approve once and deduplicate the immutable event after restart', async () => {
    const baseline = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client(),
      configuration,
      now: baselineAt,
      workspaceDir: '/workspace',
    });
    const approved = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ candidates: [candidate] }),
      configuration,
      now: baselineAt + 5 * 60 * 1000,
      state: baseline.state,
      workspaceDir: '/workspace',
    });
    const restarted = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ candidates: [candidate] }),
      configuration,
      now: baselineAt + 10 * 60 * 1000,
      state: approved.state,
      workspaceDir: '/workspace',
    });

    assert.equal(approved.approved, 1);
    assert.deepEqual(
      approved.transitions.map(({ itemKey, kind }) => ({ itemKey, kind })),
      [{ itemKey: 'github:R_repo:12', kind: 'admitted' }],
    );
    assert.deepEqual(Object.values(approved.state.items)[0]?.delivery, {
      assignmentEventId: assignment.nodeId,
      briefingIdempotencyKey: assignment.nodeId,
      schemaVersion: 1,
      stage: 'admitted',
      workId: `issue-${candidate.databaseId}`,
    });
    assert.equal(restarted.approved, 0);
    assert.equal(restarted.duplicates, 1);
    assert.deepEqual(restarted.transitions, []);
    assert.deepEqual(restarted.state.processedEventNodeIds, [assignment.nodeId]);
    assert.equal(Object.values(restarted.state.items)[0]?.disposition, 'approved');
  });

  it('should retire an active item when canonical assignment is revoked', async () => {
    const baseline = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client(),
      configuration,
      now: baselineAt,
      workspaceDir: '/workspace',
    });
    const approved = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ candidates: [candidate] }),
      configuration,
      now: baselineAt + 300_000,
      state: baseline.state,
      workspaceDir: '/workspace',
    });
    const retired = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ assigned: false }),
      configuration,
      now: baselineAt + 600_000,
      state: approved.state,
      workspaceDir: '/workspace',
    });

    assert.equal(retired.retired, 1);
    assert.deepEqual(
      retired.transitions.map(({ kind }) => kind),
      ['retired'],
    );
    assert.equal(Object.values(retired.state.items)[0]?.disposition, 'retired');
    assert.equal(Object.values(retired.state.items)[0]?.reasonCode, 'item-unassigned');
    assert.equal(Object.values(retired.state.items)[0]?.delivery?.stage, 'admitted');
  });

  it('should fail closed when discovery is truncated', async () => {
    await assert.rejects(
      pollGitHubNotifications({
        agentId: 'tanaabot',
        client: client({ truncated: true }),
        configuration,
        now: baselineAt,
        workspaceDir: '/workspace',
      }),
      (error: unknown) =>
        error instanceof GitHubNotificationPollError &&
        error.code === 'github-notification-search-truncated',
    );
  });

  it('should reject conflicting canonical database identity', async () => {
    const baseline = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client(),
      configuration,
      now: baselineAt,
      workspaceDir: '/workspace',
    });

    await assert.rejects(
      pollGitHubNotifications({
        agentId: 'tanaabot',
        client: client({ candidates: [{ ...candidate, databaseId: candidate.databaseId + 1 }] }),
        configuration,
        now: baselineAt + 300_000,
        state: baseline.state,
        workspaceDir: '/workspace',
      }),
      (error: unknown) =>
        error instanceof GitHubNotificationPollError &&
        error.code === 'github-notification-item-identity-mismatch',
    );
  });

  it('should establish a fresh baseline when the verified github account changes', async () => {
    const first = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client(),
      configuration,
      now: baselineAt,
      workspaceDir: '/workspace',
    });
    const replacement = { login: 'otherbot', nodeId: 'U_other', type: 'User' };
    const changed = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ candidates: [candidate], identity: replacement }),
      configuration,
      now: baselineAt + 300_000,
      state: first.state,
      workspaceDir: '/workspace',
    });

    assert.equal(changed.baseline, 1);
    assert.equal(changed.state.accountNodeId, replacement.nodeId);
    assert.deepEqual(changed.state.items, {});
  });

  it('should retire active items after permission, repository, or resource revocation', async () => {
    const baseline = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client(),
      configuration,
      now: baselineAt,
      workspaceDir: '/workspace',
    });
    const approved = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ candidates: [candidate] }),
      configuration,
      now: baselineAt + 300_000,
      state: baseline.state,
      workspaceDir: '/workspace',
    });
    const cases = [
      {
        expected: 'repository-permission-insufficient',
        options: { permission: 'read' as const },
      },
      {
        expected: 'repository-inactive',
        options: { repository: { ...repository, archived: true } },
      },
      {
        expected: 'github-notification-resource-changed',
        options: {
          repository: {
            ...repository,
            name: 'transferred',
            cloneUrl: 'https://github.com/other/transferred.git',
            owner: { ...repository.owner, login: 'other', nodeId: 'O_other' },
          },
        },
      },
      {
        expected: 'github-notification-resource-missing',
        options: { resourceMissing: true },
      },
    ];

    for (const entry of cases) {
      const result = await pollGitHubNotifications({
        agentId: 'tanaabot',
        client: client(entry.options),
        configuration,
        now: baselineAt + 600_000,
        state: approved.state,
        workspaceDir: '/workspace',
      });
      assert.equal(Object.values(result.state.items)[0]?.reasonCode, entry.expected);
    }
  });
});
