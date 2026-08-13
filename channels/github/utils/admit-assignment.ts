import type { GitHubNotificationsConfiguration } from '../config-schema.ts';
import type {
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
  GitHubIdentity,
  GitHubRepositoryIdentity,
  GitHubRepositoryPermission,
} from './work-item.ts';

export type GitHubAssignmentAdmissionCode =
  | 'assignment-actor-self'
  | 'assignment-actor-unsupported'
  | 'assignment-actor-unapproved'
  | 'assignment-approved'
  | 'assignment-before-baseline'
  | 'assignment-duplicate'
  | 'assignment-event-missing'
  | 'item-closed'
  | 'item-unassigned'
  | 'repository-inactive'
  | 'repository-owner-disallowed'
  | 'repository-permission-insufficient';

export interface GitHubAssignmentAdmission {
  code: GitHubAssignmentAdmissionCode;
  disposition: 'approved' | 'duplicate' | 'rejected';
  event?: GitHubAssignmentEvent;
}

export interface GitHubAssignmentAdmissionInput {
  account: GitHubIdentity;
  baselineAt: number;
  configuration: GitHubNotificationsConfiguration;
  events: readonly GitHubAssignmentEvent[];
  item: GitHubCanonicalWorkItem;
  permission: GitHubRepositoryPermission;
  processedEventNodeIds: ReadonlySet<string>;
  repository: GitHubRepositoryIdentity;
}

function rejects(code: GitHubAssignmentAdmissionCode): GitHubAssignmentAdmission {
  return { code, disposition: 'rejected' };
}

function isAccount(identity: GitHubIdentity, account: GitHubIdentity): boolean {
  return (
    identity.nodeId === account.nodeId &&
    identity.login.toLowerCase() === account.login.toLowerCase()
  );
}

/** Classify one canonical assignment using immutable identities and control facts only. */
export function admitGitHubAssignment(
  input: GitHubAssignmentAdmissionInput,
): GitHubAssignmentAdmission {
  if (input.repository.archived || input.repository.disabled) return rejects('repository-inactive');
  const allowedOwners = input.configuration.allowedRepositoryOwners;
  if (
    allowedOwners &&
    !allowedOwners.some(({ nodeId }) => nodeId === input.repository.owner.nodeId)
  ) {
    return rejects('repository-owner-disallowed');
  }
  if (!['admin', 'maintain', 'write'].includes(input.permission)) {
    return rejects('repository-permission-insufficient');
  }
  if (input.item.state !== 'open') return rejects('item-closed');
  if (!input.item.assignees.some((identity) => isAccount(identity, input.account))) {
    return rejects('item-unassigned');
  }

  const assignments = input.events
    .filter(({ assignee, event }) => event === 'assigned' && isAccount(assignee, input.account))
    .sort((left, right) => {
      const time = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return time || right.databaseId - left.databaseId;
    });
  const event = assignments[0];
  if (!event) return rejects('assignment-event-missing');
  if (input.processedEventNodeIds.has(event.nodeId)) {
    return { code: 'assignment-duplicate', disposition: 'duplicate', event };
  }
  if (Date.parse(event.createdAt) <= input.baselineAt) {
    return { code: 'assignment-before-baseline', disposition: 'rejected', event };
  }
  if (event.actor.nodeId === input.account.nodeId) {
    return { code: 'assignment-actor-self', disposition: 'rejected', event };
  }
  if (event.actor.type !== 'User') {
    return { code: 'assignment-actor-unsupported', disposition: 'rejected', event };
  }
  if (!input.configuration.approvedActors.some(({ nodeId }) => nodeId === event.actor.nodeId)) {
    return { code: 'assignment-actor-unapproved', disposition: 'rejected', event };
  }
  return { code: 'assignment-approved', disposition: 'approved', event };
}
