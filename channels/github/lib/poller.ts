import type { GitHubNotificationsConfiguration } from '../config-schema.ts';
import { admitGitHubAssignment } from '../utils/admit-assignment.ts';
import { admitGitHubComment, githubCommentRevision } from '../utils/comment-admission.ts';
import {
  createGitHubNotificationMonitorState,
  rememberProcessedEvent,
  type GitHubNotificationCommentRevisionState,
  type GitHubNotificationCommentTrackingState,
  type GitHubNotificationItemState,
  type GitHubNotificationMonitorState,
  type GitHubNotificationPullRequestState,
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
  baselineEstablished: boolean;
  commentApproved: number;
  commentBaseline: number;
  commentRejected: number;
  commentTrackingDeferred: number;
  duplicates: number;
  rejected: number;
  retired: number;
  state: GitHubNotificationMonitorState;
}

interface CommentTrackingResult {
  approved: number;
  baseline: number;
  rejected: number;
  state: GitHubNotificationCommentTrackingState;
  trackingDeferred: number;
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

function commentState(
  comment: Awaited<ReturnType<GitHubWorkEventClient['listIssueComments']>>['comments'][number],
  disposition: GitHubNotificationCommentRevisionState['disposition'],
  reasonCode: string,
): GitHubNotificationCommentRevisionState {
  const revision = githubCommentRevision(comment);
  return {
    ...(comment.author ? { actorNodeId: comment.author.nodeId } : {}),
    bodyDigest: revision.bodyDigest,
    commentDatabaseId: comment.databaseId,
    commentNodeId: comment.nodeId,
    createdAt: Date.parse(comment.createdAt),
    disposition,
    reasonCode,
    revisionId: revision.revisionId,
    ...(disposition === 'approved' ? { turn: { status: 'pending' as const } } : {}),
    updatedAt: Date.parse(comment.updatedAt),
  };
}

async function trackComments(input: {
  account: GitHubWorkEventClient['identity'];
  client: GitHubWorkEventClient;
  configuration: GitHubNotificationsConfiguration;
  item: GitHubNotificationItemState;
  now: number;
}): Promise<CommentTrackingResult> {
  const current = input.item.commentTracking;
  const page = await input.client.listIssueComments(
    input.item.repositoryOwner,
    input.item.repositoryName,
    input.item.number,
  );
  if (page.truncated) {
    return {
      approved: 0,
      baseline: 0,
      rejected: 0,
      state: {
        ...(current?.baselineAt === undefined ? {} : { baselineAt: current.baselineAt }),
        diagnosticCode: 'github-notification-comments-truncated',
        revisions: current?.revisions ?? {},
      },
      trackingDeferred: 1,
    };
  }
  const baseline = current?.baselineAt === undefined;
  let approved = 0;
  let baselineCount = 0;
  let rejected = 0;
  const revisions = Object.fromEntries(
    page.comments.map((comment) => {
      const revision = githubCommentRevision(comment);
      const previous = current?.revisions[comment.nodeId];
      if (previous?.revisionId === revision.revisionId) return [comment.nodeId, previous];
      if (baseline) {
        baselineCount += 1;
        return [comment.nodeId, commentState(comment, 'baseline', 'comment-baseline')];
      }
      const admission = admitGitHubComment({
        account: input.account,
        comment,
        configuration: input.configuration,
      });
      if (admission.disposition === 'approved') approved += 1;
      else rejected += 1;
      return [comment.nodeId, commentState(comment, admission.disposition, admission.code)];
    }),
  );
  return {
    approved,
    baseline: baselineCount,
    rejected,
    state: {
      baselineAt: current?.baselineAt ?? input.now,
      revisions,
    },
    trackingDeferred: 0,
  };
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
    commentApproved: 0,
    commentBaseline: 0,
    commentRejected: 0,
    commentTrackingDeferred: 0,
    duplicates: 0,
    rejected: 0,
    retired: 0,
  };

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
      state.searchBoundary = new Date(input.now).toISOString();
      counts.baseline = new Set(discovery.candidates.map(({ nodeId }) => nodeId)).size;
      counts.baselineEstablished = true;
      return { ...counts, state };
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
          if (current.delivery?.stage === 'active') {
            const comments = await trackComments({
              account: input.client.identity,
              client: input.client,
              configuration: input.configuration,
              item: next,
              now: input.now,
            });
            next.commentTracking = comments.state;
            counts.commentApproved += comments.approved;
            counts.commentBaseline += comments.baseline;
            counts.commentRejected += comments.rejected;
            counts.commentTrackingDeferred += comments.trackingDeferred;
          }
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
        item.itemType !== candidate.itemType ||
        (item.itemType === 'pull-request' &&
          (item.pullRequest.baseRepositoryDatabaseId !== repository.databaseId ||
            item.pullRequest.baseRepositoryNodeId !== repository.nodeId))
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
      if (admission.disposition === 'approved') {
        const comments = await trackComments({
          account: input.client.identity,
          client: input.client,
          configuration: input.configuration,
          item: nextItem,
          now: input.now,
        });
        nextItem.commentTracking = comments.state;
        counts.commentApproved += comments.approved;
        counts.commentBaseline += comments.baseline;
        counts.commentRejected += comments.rejected;
        counts.commentTrackingDeferred += comments.trackingDeferred;
      }
      state.items[key] = nextItem;
      counts[admission.disposition] += 1;
    }
    state.searchBoundary = new Date(input.now).toISOString();
    return { ...counts, state };
  } catch (error) {
    throw pollError(error, input.now);
  }
}
