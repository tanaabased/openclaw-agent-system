import type { GitHubNotificationsConfiguration } from '../../config-schema.ts';
import { admitGitHubAssignment } from '../admit-assignment.ts';
import {
  createGitHubNotificationMonitorState,
  rememberProcessedEvent,
  type GitHubNotificationItemState,
  type GitHubNotificationMonitorState,
  type GitHubNotificationPullRequestState,
} from './state.ts';
import {
  githubRepositoryPath,
  githubWorkItemKey,
  type GitHubAssignedItemCandidate,
  type GitHubCanonicalWorkItem,
  type GitHubNotificationItemSelector,
} from '../../provider/work-item.ts';
import {
  GitHubWorkEventClientError,
  type default as GitHubWorkEventClient,
} from '../../provider/work-event-client.ts';

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
  selector?: GitHubNotificationItemSelector;
  state?: GitHubNotificationMonitorState;
  workspaceDir: string;
}

export interface GitHubNotificationPollResult {
  approved: number;
  baseline: number;
  baselineEstablished: boolean;
  duplicates: number;
  rejected: number;
  retired: number;
  state: GitHubNotificationMonitorState;
}

type GitHubNotificationPollCounts = Omit<GitHubNotificationPollResult, 'state'>;

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
  assignment?: { actor: { login: string; nodeId: string }; nodeId: string },
): GitHubNotificationItemState {
  return {
    ...(assignment
      ? {
          assignmentActorLogin: assignment.actor.login,
          assignmentActorNodeId: assignment.actor.nodeId,
          assignmentEventNodeId: assignment.nodeId,
        }
      : {}),
    disposition,
    ...(disposition === 'approved' && assignment
      ? {
          intake: {
            assignmentEventId: assignment.nodeId,
            stage: 'admitted' as const,
          },
        }
      : {}),
    itemDatabaseId: item.databaseId,
    itemNodeId: item.nodeId,
    itemType: item.itemType,
    lastObservedAt: now,
    lifecycleId: item.itemType,
    number: item.number,
    ...(item.itemType === 'pull-request'
      ? { pullRequest: pullRequestState(item.pullRequest) }
      : {}),
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

function pullRequestState(
  pullRequest: Extract<
    Awaited<ReturnType<GitHubWorkEventClient['getItem']>>,
    { itemType: 'pull-request' }
  >['pullRequest'],
): GitHubNotificationPullRequestState {
  return {
    ...(pullRequest.author === undefined ? {} : { authorNodeId: pullRequest.author.nodeId }),
    baseRef: pullRequest.baseRef,
    draft: pullRequest.draft,
    headRef: pullRequest.headRef,
    ...(pullRequest.headRepositoryDatabaseId === undefined
      ? {}
      : { headRepositoryDatabaseId: pullRequest.headRepositoryDatabaseId }),
    ...(pullRequest.headRepositoryNodeId === undefined
      ? {}
      : { headRepositoryNodeId: pullRequest.headRepositoryNodeId }),
    headSha: pullRequest.headSha,
  };
}

function closedReason(
  item: Awaited<ReturnType<GitHubWorkEventClient['getItem']>>,
): string | undefined {
  if (item.state === 'open') return undefined;
  if (item.itemType === 'pull-request') {
    return item.pullRequest.merged ? 'pull-request-merged' : 'pull-request-closed';
  }
  return 'item-closed';
}

function matchesSelector(
  item: Pick<
    GitHubNotificationItemState,
    'itemType' | 'number' | 'repositoryName' | 'repositoryOwner'
  >,
  selector: GitHubNotificationItemSelector,
): boolean {
  return (
    item.itemType === selector.itemType &&
    item.number === selector.number &&
    `${item.repositoryOwner}/${item.repositoryName}`.toLowerCase() ===
      selector.repository.toLowerCase()
  );
}

async function observeCandidate(input: {
  candidate: GitHubAssignedItemCandidate;
  canonicalItem?: GitHubCanonicalWorkItem;
  client: GitHubWorkEventClient;
  configuration: GitHubNotificationsConfiguration;
  counts: GitHubNotificationPollCounts;
  now: number;
  state: GitHubNotificationMonitorState;
}): Promise<void> {
  const { name, owner } = githubRepositoryPath(input.candidate.repositoryPath);
  const repository = await input.client.getRepository(owner, name);
  const permission = await input.client.getPermission(owner, name, input.client.identity.login);
  const item =
    input.canonicalItem ?? (await input.client.getItem(owner, name, input.candidate.number));
  if (
    item.databaseId !== input.candidate.databaseId ||
    item.nodeId !== input.candidate.nodeId ||
    item.number !== input.candidate.number ||
    item.itemType !== input.candidate.itemType ||
    (item.itemType === 'pull-request' &&
      (item.pullRequest.baseRepositoryDatabaseId !== repository.databaseId ||
        item.pullRequest.baseRepositoryNodeId !== repository.nodeId))
  ) {
    throw new GitHubNotificationPollError(
      'github-notification-item-identity-mismatch',
      'GitHub returned conflicting work-item identity facts.',
    );
  }
  const eventPage = await input.client.listAssignmentEvents(owner, name, input.candidate.number);
  if (eventPage.truncated) {
    throw new GitHubNotificationPollError(
      'github-notification-events-truncated',
      'GitHub assignment event history exceeded its pagination boundary.',
    );
  }
  const admission = admitGitHubAssignment({
    account: input.client.identity,
    baselineAt: input.state.baselineAt!,
    configuration: input.configuration,
    events: eventPage.events,
    item,
    permission,
    processedEventNodeIds: new Set(input.state.processedEventNodeIds),
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
  if (assignment) rememberProcessedEvent(input.state, assignment.nodeId);
  const key = githubWorkItemKey(repository.nodeId, item.number);
  if (admission.disposition === 'duplicate') {
    input.counts.duplicates += 1;
    return;
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
  input.state.items[key] = nextItem;
  input.counts[admission.disposition] += 1;
}

/** Observe one agent's assignment control plane without creating local work. */
export async function pollGitHubNotifications(
  input: GitHubNotificationPollInput,
): Promise<GitHubNotificationPollResult> {
  const state = cloneState(input);
  const counts = {
    approved: 0,
    baseline: 0,
    baselineEstablished: false,
    duplicates: 0,
    rejected: 0,
    retired: 0,
  };

  try {
    if (input.selector && !input.configuration.assignmentTypes.includes(input.selector.itemType)) {
      throw new GitHubNotificationPollError(
        'github-notification-assignment-type-disabled',
        'The selected GitHub assignment type is disabled for this agent.',
      );
    }
    if (state.baselineAt === undefined) {
      const discovery = await input.client.discoverAssigned(
        '1970-01-01T00:00:00.000Z',
        input.configuration.assignmentTypes,
      );
      if (discovery.truncated) {
        throw new GitHubNotificationPollError(
          'github-notification-search-truncated',
          'GitHub assignment discovery was incomplete, so no baseline was recorded.',
        );
      }
      state.baselineAt = input.now;
      state.searchBoundary = new Date(input.now).toISOString();
      counts.baseline = new Set(discovery.candidates.map(({ nodeId }) => nodeId)).size;
      counts.baselineEstablished = true;
      return { ...counts, state };
    }

    let selectedExistingItem = false;
    for (const [key, current] of Object.entries(state.items)) {
      if (current.disposition !== 'approved') continue;
      if (input.selector && !matchesSelector(current, input.selector)) continue;
      if (input.selector) selectedExistingItem = true;
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
          item.nodeId !== current.itemNodeId ||
          item.itemType !== current.itemType ||
          (item.itemType === 'pull-request' &&
            (item.pullRequest.baseRepositoryDatabaseId !== current.repositoryDatabaseId ||
              item.pullRequest.baseRepositoryNodeId !== current.repositoryNodeId ||
              (current.pullRequest !== undefined &&
                (item.pullRequest.baseRef !== current.pullRequest.baseRef ||
                  item.pullRequest.headRef !== current.pullRequest.headRef ||
                  item.pullRequest.headRepositoryDatabaseId !==
                    current.pullRequest.headRepositoryDatabaseId ||
                  item.pullRequest.headRepositoryNodeId !==
                    current.pullRequest.headRepositoryNodeId ||
                  item.pullRequest.author?.nodeId !== current.pullRequest.authorNodeId))));
        const reason = identityChanged
          ? 'github-notification-resource-changed'
          : (repositoryReason ??
            closedReason(item) ??
            (isAccountAssigned(item, input.client.identity) ? undefined : 'item-unassigned'));
        if (reason) {
          state.items[key] = {
            ...current,
            disposition: 'retired',
            lastObservedAt: input.now,
            reasonCode: reason,
          };
          counts.retired += 1;
        } else {
          const next: GitHubNotificationItemState = {
            ...current,
            lastObservedAt: input.now,
            ...(item.itemType === 'pull-request' && current.pullRequest === undefined
              ? { pullRequest: pullRequestState(item.pullRequest) }
              : {}),
          };
          state.items[key] = next;
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
          counts.retired += 1;
          continue;
        }
        throw error;
      }
    }

    if (input.selector) {
      if (!selectedExistingItem) {
        const { name, owner } = githubRepositoryPath(`/repos/${input.selector.repository}`);
        const item = await input.client.getItem(owner, name, input.selector.number);
        await observeCandidate({
          candidate: {
            databaseId: item.databaseId,
            itemType: input.selector.itemType,
            nodeId: item.nodeId,
            number: input.selector.number,
            repositoryPath: `/repos/${owner}/${name}`,
            updatedAt: item.updatedAt,
          },
          canonicalItem: item,
          client: input.client,
          configuration: input.configuration,
          counts,
          now: input.now,
          state,
        });
      }
    } else {
      const boundary = Date.parse(state.searchBoundary ?? new Date(state.baselineAt).toISOString());
      const updatedSince = new Date(Math.max(0, boundary - discoveryOverlapMs)).toISOString();
      const discovery = await input.client.discoverAssigned(
        updatedSince,
        input.configuration.assignmentTypes,
      );
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
        await observeCandidate({
          candidate,
          client: input.client,
          configuration: input.configuration,
          counts,
          now: input.now,
          state,
        });
      }
      state.searchBoundary = new Date(input.now).toISOString();
    }
    return { ...counts, state };
  } catch (error) {
    throw pollError(error, input.now);
  }
}
