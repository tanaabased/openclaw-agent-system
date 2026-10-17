import type { GitHubNotificationPolicy } from '../channels/github/config-schema.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import type {
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
  GitHubRepositoryIdentity,
} from '../channels/github/provider/work-item.ts';

export const account = { login: 'receiver', nodeId: 'U_receiver', type: 'User' };
export const owner = { login: 'owner', nodeId: 'O_owner', type: 'Organization' };
export const baseline = Date.parse('2026-10-07T10:00:00Z');
export function intakeFixture() {
  const policy: GitHubNotificationPolicy = {
    schemaVersion: 2,
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
    async getPermission() {
      throw new Error('read-only intake must not require write permission');
    },
    async listAssignmentEvents() {
      return { events, truncated: false };
    },
  };
  return { policy, repository, item, events, client };
}
