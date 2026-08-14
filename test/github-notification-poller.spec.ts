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
import type { GitHubCanonicalIssueComment } from '../channels/github/utils/comment-admission.ts';
import {
  notificationAccount as account,
  notificationActor as actor,
  notificationItemKey,
  notificationMonitorState,
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
const pullRequestCandidate = {
  databaseId: 8,
  itemType: 'pull-request' as const,
  nodeId: 'PR_item',
  number: 13,
  repositoryPath: '/repos/tanaabased/example',
  updatedAt: '2026-08-11T12:06:00.000Z',
};
const pullRequestItem = {
  assignees: [account],
  databaseId: pullRequestCandidate.databaseId,
  itemType: 'pull-request' as const,
  nodeId: pullRequestCandidate.nodeId,
  number: pullRequestCandidate.number,
  pullRequest: {
    author: actor,
    baseRef: 'main',
    baseRepositoryDatabaseId: repository.databaseId,
    baseRepositoryNodeId: repository.nodeId,
    draft: false,
    headRef: 'notification-pr',
    headRepositoryDatabaseId: repository.databaseId,
    headRepositoryNodeId: repository.nodeId,
    headSha: 'a'.repeat(40),
    merged: false,
  },
  state: 'open' as const,
  updatedAt: pullRequestCandidate.updatedAt,
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
  allowedRepositoryOwners: [{ login: repository.owner.login, nodeId: repository.owner.nodeId }],
  intervalMinutes: 5,
};

function client(
  options: {
    assigned?: boolean;
    candidates?: Array<typeof candidate | typeof pullRequestCandidate>;
    comments?: GitHubCanonicalIssueComment[];
    commentsTruncated?: boolean;
    identity?: typeof account;
    item?: typeof item | (Omit<typeof pullRequestItem, 'state'> & { state: 'closed' | 'open' });
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
      const selected = options.item ?? item;
      return {
        ...selected,
        assignees: options.assigned === false ? [] : selected.assignees,
      };
    },
    async listAssignmentEvents() {
      return { events: [assignment], truncated: false };
    },
    async listIssueComments() {
      return {
        comments: options.comments ?? [],
        truncated: options.commentsTruncated ?? false,
      };
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
    assert.equal(result.baselineEstablished, true);
    assert.equal(result.approved, 0);
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

    assert.equal(baseline.baseline, 0);
    assert.equal(baseline.baselineEstablished, true);
    assert.equal(baseline.state.baselineAt, baselineAt);
    assert.equal(approved.approved, 1);
    assert.equal(approved.baselineEstablished, false);
    assert.deepEqual(Object.values(approved.state.items)[0]?.delivery, {
      assignmentEventId: assignment.nodeId,
      schemaVersion: 1,
      stage: 'admitted',
      workId: `issue-${candidate.databaseId}`,
    });
    assert.equal(restarted.approved, 0);
    assert.equal(restarted.duplicates, 1);
    assert.deepEqual(restarted.state.processedEventNodeIds, [assignment.nodeId]);
    assert.equal(Object.values(restarted.state.items)[0]?.disposition, 'approved');
  });

  it('should admit a direct pull request with a fixed head snapshot and comment baseline', async () => {
    const existing: GitHubCanonicalIssueComment = {
      author: actor,
      body: '@tanaabot old review note',
      bodyTruncated: false,
      createdAt: '2026-08-11T12:06:00.000Z',
      databaseId: 93,
      nodeId: 'IC_pull_request_existing',
      updatedAt: '2026-08-11T12:06:00.000Z',
    };
    const baseline = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client(),
      configuration,
      now: baselineAt,
      workspaceDir: '/workspace',
    });
    const approved = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({
        candidates: [pullRequestCandidate],
        comments: [existing],
        item: pullRequestItem,
      }),
      configuration,
      now: baselineAt + 300_000,
      state: baseline.state,
      workspaceDir: '/workspace',
    });

    const approvedItem = Object.values(approved.state.items)[0];
    assert.equal(approved.approved, 1);
    assert.equal(approved.commentBaseline, 1);
    assert.equal(approvedItem?.itemType, 'pull-request');
    assert.deepEqual(approvedItem?.delivery, {
      assignmentEventId: assignment.nodeId,
      schemaVersion: 1,
      stage: 'admitted',
      workId: 'pull-request-8',
    });
    assert.deepEqual(approvedItem?.pullRequest, {
      authorNodeId: actor.nodeId,
      baseRef: 'main',
      draft: false,
      headRef: 'notification-pr',
      headRepositoryDatabaseId: repository.databaseId,
      headRepositoryNodeId: repository.nodeId,
      headSha: 'a'.repeat(40),
    });
    assert.equal(
      approvedItem?.commentTracking?.revisions.IC_pull_request_existing?.disposition,
      'baseline',
    );
  });

  it('should distinguish merged and closed pull-request retirement', async () => {
    const state = notificationMonitorState();
    const pullRequestState = structuredClone(state);
    const approved = {
      ...Object.values(pullRequestState.items)[0]!,
      delivery: {
        assignmentEventId: assignment.nodeId,
        schemaVersion: 1 as const,
        stage: 'active' as const,
        workId: 'pull-request-8',
        worktreeBranch: 'pull-request-8-branch',
        worktreePath: '/workspace/worktrees/pull-request-8',
        sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:13',
        activation: { status: 'planned' as const },
        acknowledgment: { commentId: 90, status: 'published' as const },
      },
      itemDatabaseId: pullRequestItem.databaseId,
      itemNodeId: pullRequestItem.nodeId,
      itemType: 'pull-request' as const,
      number: pullRequestItem.number,
      pullRequest: {
        authorNodeId: actor.nodeId,
        baseRef: 'main',
        draft: false,
        headRef: 'notification-pr',
        headRepositoryDatabaseId: repository.databaseId,
        headRepositoryNodeId: repository.nodeId,
        headSha: 'a'.repeat(40),
      },
    };
    pullRequestState.items = { 'github:R_repo:13': approved };
    for (const [merged, expected] of [
      [true, 'pull-request-merged'],
      [false, 'pull-request-closed'],
    ] as const) {
      const result = await pollGitHubNotifications({
        agentId: 'tanaabot',
        client: client({
          item: {
            ...pullRequestItem,
            pullRequest: { ...pullRequestItem.pullRequest, merged },
            state: 'closed',
          },
        }),
        configuration,
        now: baselineAt + 600_000,
        state: pullRequestState,
        workspaceDir: '/workspace',
      });
      assert.equal(Object.values(result.state.items)[0]?.reasonCode, expected);
    }
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

  it('should baseline active issue comments before admitting a later exact mention', async () => {
    const existing: GitHubCanonicalIssueComment = {
      author: actor,
      body: '@tanaabot old status?',
      bodyTruncated: false,
      createdAt: '2026-08-11T12:05:00.000Z',
      databaseId: 91,
      nodeId: 'IC_existing',
      updatedAt: '2026-08-11T12:05:00.000Z',
    };
    const baseline = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client(),
      configuration,
      now: baselineAt,
      workspaceDir: '/workspace',
    });
    const approved = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ candidates: [candidate], comments: [existing] }),
      configuration,
      now: baselineAt + 300_000,
      state: baseline.state,
      workspaceDir: '/workspace',
    });
    const active = structuredClone(approved.state);
    const activeItem = Object.values(active.items)[0]!;
    activeItem.delivery = {
      ...activeItem.delivery!,
      activation: { status: 'planned' },
      acknowledgment: { commentId: 90, status: 'published' },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    assert.equal(approved.commentBaseline, 1);
    assert.equal(activeItem.commentTracking?.revisions.IC_existing?.disposition, 'baseline');

    const mentioned: GitHubCanonicalIssueComment = {
      ...existing,
      body: '@tanaabot can you give me a status update?',
      createdAt: '2026-08-11T12:11:00.000Z',
      databaseId: 92,
      nodeId: 'IC_mentioned',
      updatedAt: '2026-08-11T12:11:00.000Z',
    };
    const second = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ comments: [existing, mentioned] }),
      configuration,
      now: baselineAt + 900_000,
      state: active,
      workspaceDir: '/workspace',
    });
    const revision = Object.values(second.state.items)[0]?.commentTracking?.revisions.IC_mentioned;
    assert.equal(second.commentApproved, 1);
    assert.equal(revision?.disposition, 'approved');
    assert.deepEqual(revision?.turn, { status: 'pending' });

    const edited = { ...mentioned, body: 'Never mind.', updatedAt: '2026-08-11T12:12:00.000Z' };
    const third = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ comments: [existing, edited] }),
      configuration,
      now: baselineAt + 1_200_000,
      state: second.state,
      workspaceDir: '/workspace',
    });
    const editedRevision = Object.values(third.state.items)[0]?.commentTracking?.revisions
      .IC_mentioned;
    assert.equal(third.commentRejected, 1);
    assert.equal(editedRevision?.disposition, 'rejected');
    assert.equal(editedRevision?.turn, undefined);
    assert.notEqual(editedRevision?.revisionId, revision?.revisionId);
  });

  it('should retain the prior comment checkpoint when comment pagination is incomplete', async () => {
    const state = notificationMonitorState();
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      activation: { status: 'planned' },
      acknowledgment: { commentId: 90, status: 'published' },
      sessionKey: 'agent:tanaabot:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/tanaabot/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    item.commentTracking = { baselineAt, revisions: {} };
    const before = structuredClone(item.commentTracking);
    const result = await pollGitHubNotifications({
      agentId: 'tanaabot',
      client: client({ commentsTruncated: true }),
      configuration,
      now: baselineAt + 900_000,
      state,
      workspaceDir: '/workspace',
    });
    const tracking = Object.values(result.state.items)[0]?.commentTracking;
    assert.equal(result.commentTrackingDeferred, 1);
    assert.equal(tracking?.diagnosticCode, 'github-notification-comments-truncated');
    assert.deepEqual(tracking?.revisions, before?.revisions);
  });
});
