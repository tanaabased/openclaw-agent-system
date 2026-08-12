import type { GitHubNotificationsConfiguration } from '../config-schema.ts';
import { admitGitHubAssignment } from '../utils/admit-assignment.ts';
import {
  createGitHubNotificationMonitorState,
  rememberProcessedEvent,
  type GitHubNotificationItemState,
  type GitHubNotificationMonitorState,
} from '../utils/monitor-state.ts';
import { githubRepositoryPath, githubWorkItemKey } from '../utils/work-item.ts';
import {
  GitHubWorkEventClientError,
  type default as GitHubWorkEventClient,
} from './work-event-client.ts';

const discoveryOverlapMs = 5 * 60 * 1000;

export class GitHubNotificationPollError extends Error {
  override name = 'GitHubNotificationPollError';

  constructor(
    readonly code: string,
    message: string,
    readonly retryAt?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GitHubNotificationPollInput {
  agentId: string;
  client: GitHubWorkEventClient;
  configuration: GitHubNotificationsConfiguration;
  now: number;
  state?: GitHubNotificationMonitorState;
  workspaceDir: string;
}

export interface GitHubNotificationPollResult {
  approved: number;
  baseline: number;
  duplicates: number;
  rejected: number;
  retired: number;
  state: GitHubNotificationMonitorState;
  transitions: GitHubNotificationTransition[];
}

export interface GitHubNotificationTransition {
  itemKey: string;
  kind: 'admitted' | 'retired';
}

function pollError(error: unknown, now: number): GitHubNotificationPollError {
  if (error instanceof GitHubNotificationPollError) return error;
  if (error instanceof GitHubWorkEventClientError) {
    const retryAt = Math.max(
      error.rateLimit.resetAt ?? 0,
      error.rateLimit.retryAfterMs ? now + error.rateLimit.retryAfterMs : 0,
    );
    return new GitHubNotificationPollError(
      error.code,
      error.message,
      retryAt > 0 ? retryAt : undefined,
      { cause: error },
    );
  }
  return new GitHubNotificationPollError(
    'github-notification-poll-failed',
    'The GitHub notification poll could not complete.',
    undefined,
    { cause: error },
  );
}

function cloneState(input: GitHubNotificationPollInput): GitHubNotificationMonitorState {
  let state = input.state
    ? structuredClone(input.state)
    : createGitHubNotificationMonitorState(input.agentId, input.workspaceDir);
  if (state.agentId !== input.agentId || state.workspaceDir !== input.workspaceDir) {
    throw new GitHubNotificationPollError(
      'github-notification-state-scope-mismatch',
      'The GitHub notification monitor state belongs to another agent scope.',
    );
  }
  if (state.accountNodeId && state.accountNodeId !== input.client.identity.nodeId) {
    state = createGitHubNotificationMonitorState(input.agentId, input.workspaceDir);
  }
  state.accountLogin = input.client.identity.login;
  state.accountNodeId = input.client.identity.nodeId;
  return state;
}

function isAccountAssigned(
  item: { assignees: Array<{ login: string; nodeId: string }> },
  account: { login: string; nodeId: string },
): boolean {
  return item.assignees.some(
    ({ login, nodeId }) =>
      nodeId === account.nodeId && login.toLowerCase() === account.login.toLowerCase(),
  );
}

function repositoryAllowed(
  configuration: GitHubNotificationsConfiguration,
  repository: { archived: boolean; disabled: boolean; owner: { nodeId: string } },
  permission: string,
): string | undefined {
  if (repository.archived || repository.disabled) return 'repository-inactive';
  if (
    configuration.allowedRepositoryOwners &&
    !configuration.allowedRepositoryOwners.some(({ nodeId }) => nodeId === repository.owner.nodeId)
  ) {
    return 'repository-owner-disallowed';
  }
  return ['admin', 'maintain', 'write'].includes(permission)
    ? undefined
    : 'repository-permission-insufficient';
}

function itemState(
  disposition: GitHubNotificationItemState['disposition'],
  reasonCode: string,
  now: number,
  repository: Awaited<ReturnType<GitHubWorkEventClient['getRepository']>>,
  item: Awaited<ReturnType<GitHubWorkEventClient['getItem']>>,
  permission: Awaited<ReturnType<GitHubWorkEventClient['getPermission']>>,
  assignment?: { actor: { nodeId: string }; nodeId: string },
): GitHubNotificationItemState {
  return {
    ...(assignment
      ? {
          assignmentActorNodeId: assignment.actor.nodeId,
          assignmentEventNodeId: assignment.nodeId,
        }
      : {}),
    disposition,
    ...(disposition === 'approved' && assignment
      ? {
          delivery: {
            assignmentEventId: assignment.nodeId,
            briefingIdempotencyKey: assignment.nodeId,
            schemaVersion: 1 as const,
            stage: 'admitted' as const,
            workId: `${item.itemType}-${item.databaseId}`,
          },
        }
      : {}),
    itemDatabaseId: item.databaseId,
    itemNodeId: item.nodeId,
    itemType: item.itemType,
    lastObservedAt: now,
    number: item.number,
    reasonCode,
    repositoryCloneUrl: repository.cloneUrl,
    repositoryDatabaseId: repository.databaseId,
    repositoryDefaultBranch: repository.defaultBranch,
    repositoryName: repository.name,
    repositoryNodeId: repository.nodeId,
    repositoryOwner: repository.owner.login,
    repositoryOwnerNodeId: repository.owner.nodeId,
    repositoryPermission: permission,
  };
}

/** Observe one agent's assignment control plane without creating local work. */
export async function pollGitHubNotifications(
  input: GitHubNotificationPollInput,
): Promise<GitHubNotificationPollResult> {
  const state = cloneState(input);
  const counts = { approved: 0, baseline: 0, duplicates: 0, rejected: 0, retired: 0 };
  const transitions: GitHubNotificationTransition[] = [];

  try {
    if (state.baselineAt === undefined) {
      const discovery = await input.client.discoverAssigned('1970-01-01T00:00:00.000Z');
      if (discovery.truncated) {
        throw new GitHubNotificationPollError(
          'github-notification-search-truncated',
          'GitHub assignment discovery was incomplete, so no baseline was recorded.',
        );
      }
      state.baselineAt = input.now;
      state.baselineItemNodeIds = [...new Set(discovery.candidates.map(({ nodeId }) => nodeId))];
      state.searchBoundary = new Date(input.now).toISOString();
      counts.baseline = state.baselineItemNodeIds.length;
      return { ...counts, state, transitions };
    }

    for (const [key, current] of Object.entries(state.items)) {
      if (current.disposition !== 'approved') continue;
      try {
        const repository = await input.client.getRepository(
          current.repositoryOwner,
          current.repositoryName,
        );
        const permission = await input.client.getPermission(
          current.repositoryOwner,
          current.repositoryName,
          input.client.identity.login,
        );
        const item = await input.client.getItem(
          current.repositoryOwner,
          current.repositoryName,
          current.number,
        );
        const repositoryReason = repositoryAllowed(input.configuration, repository, permission);
        const identityChanged =
          repository.databaseId !== current.repositoryDatabaseId ||
          repository.nodeId !== current.repositoryNodeId ||
          repository.owner.login !== current.repositoryOwner ||
          repository.name !== current.repositoryName ||
          item.databaseId !== current.itemDatabaseId ||
          item.nodeId !== current.itemNodeId;
        const reason = identityChanged
          ? 'github-notification-resource-changed'
          : (repositoryReason ??
            (item.state !== 'open'
              ? 'item-closed'
              : isAccountAssigned(item, input.client.identity)
                ? undefined
                : 'item-unassigned'));
        if (reason) {
          state.items[key] = {
            ...current,
            disposition: 'retired',
            lastObservedAt: input.now,
            reasonCode: reason,
          };
          transitions.push({
            itemKey: key,
            kind: 'retired',
          });
          counts.retired += 1;
        } else {
          state.items[key] = { ...current, lastObservedAt: input.now };
        }
      } catch (error) {
        if (
          error instanceof GitHubWorkEventClientError &&
          error.code === 'github-notification-resource-missing'
        ) {
          state.items[key] = {
            ...current,
            disposition: 'retired',
            lastObservedAt: input.now,
            reasonCode: 'github-notification-resource-missing',
          };
          transitions.push({
            itemKey: key,
            kind: 'retired',
          });
          counts.retired += 1;
          continue;
        }
        throw error;
      }
    }

    const boundary = Date.parse(state.searchBoundary ?? new Date(state.baselineAt).toISOString());
    const updatedSince = new Date(Math.max(0, boundary - discoveryOverlapMs)).toISOString();
    const discovery = await input.client.discoverAssigned(updatedSince);
    if (discovery.truncated) {
      throw new GitHubNotificationPollError(
        'github-notification-search-truncated',
        'GitHub assignment discovery was incomplete, so the search boundary was retained.',
      );
    }
    const seenCandidates = new Set<string>();
    for (const candidate of discovery.candidates) {
      if (seenCandidates.has(candidate.nodeId)) continue;
      seenCandidates.add(candidate.nodeId);
      const { name, owner } = githubRepositoryPath(candidate.repositoryPath);
      const repository = await input.client.getRepository(owner, name);
      const permission = await input.client.getPermission(owner, name, input.client.identity.login);
      const item = await input.client.getItem(owner, name, candidate.number);
      if (
        item.databaseId !== candidate.databaseId ||
        item.nodeId !== candidate.nodeId ||
        item.number !== candidate.number ||
        item.itemType !== candidate.itemType
      ) {
        throw new GitHubNotificationPollError(
          'github-notification-item-identity-mismatch',
          'GitHub returned conflicting work-item identity facts.',
        );
      }
      const eventPage = await input.client.listAssignmentEvents(owner, name, candidate.number);
      if (eventPage.truncated) {
        throw new GitHubNotificationPollError(
          'github-notification-events-truncated',
          'GitHub assignment event history exceeded its pagination boundary.',
        );
      }
      const admission = admitGitHubAssignment({
        account: input.client.identity,
        baselineAt: state.baselineAt,
        configuration: input.configuration,
        events: eventPage.events,
        item,
        permission,
        processedEventNodeIds: new Set(state.processedEventNodeIds),
        repository,
      });
      const assignment =
        admission.event ??
        eventPage.events
          .filter(
            ({ assignee, event }) =>
              event === 'assigned' && assignee.nodeId === input.client.identity.nodeId,
          )
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
      if (assignment) rememberProcessedEvent(state, assignment.nodeId);
      const key = githubWorkItemKey(repository.nodeId, item.number);
      if (admission.disposition === 'duplicate') {
        counts.duplicates += 1;
        continue;
      }
      const nextItem = itemState(
        admission.disposition,
        admission.code,
        input.now,
        repository,
        item,
        permission,
        assignment,
      );
      state.items[key] = nextItem;
      if (admission.disposition === 'approved') {
        transitions.push({ itemKey: key, kind: 'admitted' });
      }
      counts[admission.disposition] += 1;
    }
    state.searchBoundary = new Date(input.now).toISOString();
    return { ...counts, state, transitions };
  } catch (error) {
    throw pollError(error, input.now);
  }
}
