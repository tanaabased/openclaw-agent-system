import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import { automationHash } from '../agent/automation-hash.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import type {
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
  GitHubRepositoryIdentity,
} from '../channels/github/provider/work-item.ts';

export const account = { login: 'receiver', nodeId: 'U_receiver', type: 'User' };
export const owner = { login: 'owner', nodeId: 'O_owner', type: 'Organization' };
export const baseline = Date.parse('2026-10-07T10:00:00Z');
// reproduce the original admission contract independently of current compatibility code.
export function originalIntakeDigest(manifest: AgentManifest) {
  const policy = manifest.github!.notifications!;
  return automationHash({
    username: manifest.github!.username,
    host: manifest.github!.host,
    policy: {
      schemaVersion: policy.schemaVersion,
      runtimes: policy.runtimes,
      intervalMinutes: policy.intervalMinutes,
      maxConcurrentItems: policy.maxConcurrentItems,
      allowedRepositoryOwners: policy.allowedRepositoryOwners,
      issueAssignment: policy.issueAssignment,
    },
  });
}
export function intakeFixture() {
  const policy: GitHubNotificationPolicy = {
    schemaVersion: 3,
    runtimes: ['codex'],
    intervalMinutes: 5,
    maxConcurrentItems: 2,
    allowedRepositoryOwners: [owner],
    issueAssignment: { allowed: [account], mode: 'plan' },
  };
  const repository: GitHubRepositoryIdentity = {
    nodeId: 'R_repo',
    databaseId: 10,
    owner,
    name: 'repo',
    cloneUrl: 'https://github.com/owner/repo.git',
    defaultBranch: 'main',
    archived: false,
    disabled: false,
  };
  const item: GitHubCanonicalWorkItem = {
    nodeId: 'I_issue',
    databaseId: 20,
    number: 3,
    itemType: 'issue',
    state: 'open',
    updatedAt: '2026-10-07T10:01:00Z',
    assignees: [account],
  };
  const events: GitHubAssignmentEvent[] = [
    {
      nodeId: 'E_assignment',
      databaseId: 30,
      event: 'assigned',
      actor: account,
      assignee: account,
      createdAt: '2026-10-07T10:01:00Z',
    },
  ];
  const client: GitHubNotificationIntakeClient = {
    identity: account,
    async discoverAssigned() {
      return {
        candidates: [
          {
            nodeId: item.nodeId,
            databaseId: item.databaseId,
            number: item.number,
            itemType: 'issue',
            updatedAt: item.updatedAt,
            repositoryPath: '/repos/owner/repo',
          },
        ],
        incomplete: false,
        totalCount: 1,
        truncated: false,
      };
    },
    async getRepository() {
      return repository;
    },
    async getItem() {
      return item;
    },
    async listAssignmentEvents() {
      return { events, truncated: false };
    },
  };
  return { policy, repository, item, events, client };
}

export function removeFixtureAssignment(fixture: ReturnType<typeof intakeFixture>) {
  fixture.item.assignees = [];
  const event = {
    ...fixture.events[0]!,
    event: 'unassigned' as const,
    nodeId: 'E_unassignment',
    databaseId: 31,
    createdAt: '2026-10-07T10:02:00Z',
  };
  fixture.events.push(event);
  return event;
}

/** same-repository operator continuation, independent of assignment eligibility and PR authorship. */
export function fixturePullRequest(
  fixture: ReturnType<typeof intakeFixture>,
  headSha = '1'.repeat(40),
) {
  const pullRequest = {
    author: { login: 'operator', nodeId: 'U_operator', type: 'User' },
    baseRef: 'release',
    baseRepositoryDatabaseId: fixture.repository.databaseId,
    baseRepositoryNodeId: fixture.repository.nodeId,
    draft: true,
    headRef: 'existing-work',
    headRepositoryDatabaseId: fixture.repository.databaseId,
    headRepositoryNodeId: fixture.repository.nodeId,
    headSha,
    merged: false,
  };
  Object.assign(fixture.item, {
    itemType: 'pull-request',
    nodeId: 'PR_existing',
    pullRequest,
    assignees: [],
  });
  return pullRequest;
}
