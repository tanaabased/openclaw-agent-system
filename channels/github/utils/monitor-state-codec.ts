import { isAbsolute } from 'node:path';

import {
  type GitHubNotificationCommentRevisionState,
  type GitHubNotificationCommentTrackingState,
  type GitHubNotificationDeliveryState,
  type GitHubNotificationItemState,
  type GitHubNotificationMonitorState,
} from './monitor-state.ts';

export type GitHubNotificationMonitorStateDecodeResult = {
  state: GitHubNotificationMonitorState;
  status: 'ready';
};

const stateKeys = new Set([
  'accountLogin',
  'accountNodeId',
  'agentId',
  'baselineAt',
  'diagnosticCode',
  'failureCount',
  'items',
  'lastPollAt',
  'lastSuccessfulPollAt',
  'nextPollAt',
  'processedEventNodeIds',
  'schemaVersion',
  'searchBoundary',
  'workspaceDir',
]);

const itemBaseKeys = new Set([
  'assignmentActorLogin',
  'assignmentActorNodeId',
  'assignmentEventNodeId',
  'commentTracking',
  'disposition',
  'itemNodeId',
  'itemType',
  'lastObservedAt',
  'number',
  'pullRequest',
  'reasonCode',
  'repositoryCloneUrl',
  'repositoryDatabaseId',
  'repositoryDefaultBranch',
  'repositoryName',
  'repositoryNodeId',
  'repositoryOwner',
  'repositoryOwnerNodeId',
  'repositoryPermission',
]);

const itemKeys = new Set([...itemBaseKeys, 'delivery', 'itemDatabaseId']);

const deliveryKeys = new Set([
  'activation',
  'acknowledgment',
  'assignmentEventId',
  'failureCode',
  'mode',
  'schemaVersion',
  'sessionId',
  'sessionKey',
  'stage',
  'workId',
  'worktreeBranch',
  'worktreePath',
]);

const publicationKeys = new Set(['commentId', 'failureCode', 'status']);
const activationKeys = new Set(['failureCode', 'reply', 'status']);
const commentTrackingKeys = new Set(['baselineAt', 'diagnosticCode', 'revisions']);
const commentRevisionKeys = new Set([
  'actorNodeId',
  'bodyDigest',
  'commentDatabaseId',
  'commentNodeId',
  'createdAt',
  'disposition',
  'reasonCode',
  'reply',
  'revisionId',
  'turn',
  'updatedAt',
]);
const commentTurnKeys = new Set(['failureCode', 'status']);
const pullRequestKeys = new Set([
  'authorNodeId',
  'baseRef',
  'draft',
  'headRef',
  'headRepositoryDatabaseId',
  'headRepositoryNodeId',
  'headSha',
]);

function hasOnlyKeys(value: object, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function validNodeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.includes('\0') &&
    !/\s/u.test(value)
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function validItemFields(
  value: Record<string, unknown>,
  item: Partial<GitHubNotificationItemState>,
): boolean {
  return (
    ['approved', 'baseline', 'rejected', 'retired'].includes(item.disposition ?? '') &&
    validNodeId(item.itemNodeId) &&
    (item.itemType === 'issue' || item.itemType === 'pull-request') &&
    typeof item.lastObservedAt === 'number' &&
    Number.isFinite(item.lastObservedAt) &&
    Number.isSafeInteger(item.number) &&
    Number(item.number) > 0 &&
    typeof item.reasonCode === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/u.test(item.reasonCode) &&
    Number.isSafeInteger(item.repositoryDatabaseId) &&
    Number(item.repositoryDatabaseId) >= 0 &&
    typeof item.repositoryCloneUrl === 'string' &&
    item.repositoryCloneUrl.length > 0 &&
    typeof item.repositoryDefaultBranch === 'string' &&
    item.repositoryDefaultBranch.length > 0 &&
    item.repositoryDefaultBranch.length <= 255 &&
    !hasControlCharacter(item.repositoryDefaultBranch) &&
    typeof item.repositoryName === 'string' &&
    /^[A-Za-z0-9_.-]+$/u.test(item.repositoryName) &&
    validNodeId(item.repositoryNodeId) &&
    typeof item.repositoryOwner === 'string' &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(item.repositoryOwner) &&
    item.repositoryCloneUrl.toLowerCase() ===
      `https://github.com/${item.repositoryOwner}/${item.repositoryName}.git`.toLowerCase() &&
    validNodeId(item.repositoryOwnerNodeId) &&
    ['admin', 'maintain', 'none', 'read', 'triage', 'write'].includes(
      item.repositoryPermission ?? '',
    ) &&
    (item.assignmentActorNodeId === undefined || validNodeId(item.assignmentActorNodeId)) &&
    (item.assignmentActorLogin === undefined ||
      (typeof item.assignmentActorLogin === 'string' &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(item.assignmentActorLogin))) &&
    (item.assignmentEventNodeId === undefined || validNodeId(item.assignmentEventNodeId)) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function optionalBoundedString(value: unknown, maximumLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maximumLength &&
      !hasControlCharacter(value))
  );
}

function validPullRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pullRequest = value as {
    authorNodeId?: unknown;
    baseRef?: unknown;
    draft?: unknown;
    headRef?: unknown;
    headRepositoryDatabaseId?: unknown;
    headRepositoryNodeId?: unknown;
    headSha?: unknown;
  };
  const hasHeadRepositoryDatabaseId = pullRequest.headRepositoryDatabaseId !== undefined;
  const hasHeadRepositoryNodeId = pullRequest.headRepositoryNodeId !== undefined;
  return (
    hasOnlyKeys(value, pullRequestKeys) &&
    (pullRequest.authorNodeId === undefined || validNodeId(pullRequest.authorNodeId)) &&
    optionalBoundedString(pullRequest.baseRef, 255) &&
    typeof pullRequest.baseRef === 'string' &&
    typeof pullRequest.draft === 'boolean' &&
    optionalBoundedString(pullRequest.headRef, 255) &&
    typeof pullRequest.headRef === 'string' &&
    hasHeadRepositoryDatabaseId === hasHeadRepositoryNodeId &&
    (pullRequest.headRepositoryDatabaseId === undefined ||
      (Number.isSafeInteger(pullRequest.headRepositoryDatabaseId) &&
        Number(pullRequest.headRepositoryDatabaseId) > 0)) &&
    (pullRequest.headRepositoryNodeId === undefined ||
      validNodeId(pullRequest.headRepositoryNodeId)) &&
    typeof pullRequest.headSha === 'string' &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(pullRequest.headSha)
  );
}

function validPublication(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const acknowledgment = value as {
    commentId?: unknown;
    failureCode?: unknown;
    status?: unknown;
  };
  if (!hasOnlyKeys(value, publicationKeys)) return false;
  if (acknowledgment.status === 'pending') {
    return acknowledgment.commentId === undefined && acknowledgment.failureCode === undefined;
  }
  if (acknowledgment.status === 'failed') {
    return (
      acknowledgment.commentId === undefined &&
      optionalBoundedString(acknowledgment.failureCode, 255) &&
      typeof acknowledgment.failureCode === 'string' &&
      /^[a-z0-9][a-z0-9-]*$/u.test(acknowledgment.failureCode)
    );
  }
  return (
    acknowledgment.status === 'published' &&
    acknowledgment.failureCode === undefined &&
    Number.isSafeInteger(acknowledgment.commentId) &&
    Number(acknowledgment.commentId) > 0
  );
}

function validDeprecatedDeliveryCheckpoints(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoints = value as Record<string, unknown>;
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(checkpoints).length <= 100 &&
    Object.entries(checkpoints).every(
      ([publicationId, checkpoint]) =>
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
          publicationId,
        ) && validPublication(checkpoint),
    )
  );
}

function validActivation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const activation = value as { failureCode?: unknown; reply?: unknown; status?: unknown };
  return (
    hasOnlyKeys(value, activationKeys) &&
    ['adopted', 'failed', 'ineligible', 'pending', 'planned'].includes(String(activation.status)) &&
    optionalBoundedString(activation.failureCode, 255) &&
    (activation.failureCode === undefined ||
      /^[a-z0-9][a-z0-9-]*$/u.test(String(activation.failureCode))) &&
    (activation.reply === undefined ||
      (activation.status === 'planned' && validPublication(activation.reply)))
  );
}

function validCommentTurn(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const turn = value as { failureCode?: unknown; status?: unknown };
  return (
    hasOnlyKeys(value, commentTurnKeys) &&
    ['adopted', 'failed', 'pending', 'responded'].includes(String(turn.status)) &&
    optionalBoundedString(turn.failureCode, 255) &&
    (turn.failureCode === undefined || /^[a-z0-9][a-z0-9-]*$/u.test(String(turn.failureCode)))
  );
}

function validCommentRevision(value: unknown): value is GitHubNotificationCommentRevisionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const revision = value as Partial<GitHubNotificationCommentRevisionState>;
  const base =
    hasOnlyKeys(value, commentRevisionKeys) &&
    (revision.actorNodeId === undefined || validNodeId(revision.actorNodeId)) &&
    typeof revision.bodyDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(revision.bodyDigest) &&
    Number.isSafeInteger(revision.commentDatabaseId) &&
    Number(revision.commentDatabaseId) > 0 &&
    validNodeId(revision.commentNodeId) &&
    optionalFiniteNumber(revision.createdAt) &&
    typeof revision.createdAt === 'number' &&
    ['approved', 'baseline', 'rejected'].includes(revision.disposition ?? '') &&
    typeof revision.reasonCode === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/u.test(revision.reasonCode) &&
    typeof revision.revisionId === 'string' &&
    /^[a-f0-9]{64}$/u.test(revision.revisionId) &&
    optionalFiniteNumber(revision.updatedAt) &&
    typeof revision.updatedAt === 'number' &&
    revision.updatedAt >= revision.createdAt;
  if (!base) return false;
  if (revision.disposition !== 'approved') {
    return revision.turn === undefined && revision.reply === undefined;
  }
  const turn = revision.turn;
  if (!turn || !validCommentTurn(turn)) return false;
  if (turn.status === 'responded') {
    return validPublication(revision.reply);
  }
  return revision.reply === undefined;
}

function validCommentTracking(value: unknown): value is GitHubNotificationCommentTrackingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tracking = value as Partial<GitHubNotificationCommentTrackingState>;
  if (
    !hasOnlyKeys(value, commentTrackingKeys) ||
    !optionalFiniteNumber(tracking.baselineAt) ||
    (tracking.diagnosticCode !== undefined &&
      (typeof tracking.diagnosticCode !== 'string' ||
        !/^[a-z0-9][a-z0-9-]*$/u.test(tracking.diagnosticCode))) ||
    !tracking.revisions ||
    Array.isArray(tracking.revisions) ||
    Object.keys(tracking.revisions).length > 1_000
  ) {
    return false;
  }
  if (tracking.baselineAt === undefined && Object.keys(tracking.revisions).length > 0) return false;
  return Object.entries(tracking.revisions).every(
    ([key, revision]) => validCommentRevision(revision) && key === revision.commentNodeId,
  );
}

function validDelivery(
  value: unknown,
  itemType: GitHubNotificationItemState['itemType'],
): value is GitHubNotificationDeliveryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const delivery = value as Partial<GitHubNotificationDeliveryState>;
  const validBase =
    hasOnlyKeys(value, deliveryKeys) &&
    delivery.schemaVersion === 1 &&
    (delivery.activation === undefined || validActivation(delivery.activation)) &&
    (delivery.acknowledgment === undefined || validPublication(delivery.acknowledgment)) &&
    validNodeId(delivery.assignmentEventId) &&
    ['active', 'admitted', 'received', 'retired', 'session-recording', 'worktree-ready'].includes(
      delivery.stage ?? '',
    ) &&
    optionalBoundedString(delivery.failureCode, 255) &&
    (delivery.mode === undefined || ['auto', 'plan', 'work'].includes(delivery.mode)) &&
    (delivery.failureCode === undefined || /^[a-z0-9][a-z0-9-]*$/u.test(delivery.failureCode)) &&
    optionalBoundedString(delivery.sessionId, 255) &&
    optionalBoundedString(delivery.sessionKey, 1_024) &&
    optionalBoundedString(delivery.workId, 256) &&
    optionalBoundedString(delivery.worktreeBranch, 255) &&
    optionalBoundedString(delivery.worktreePath, 4_096) &&
    typeof delivery.workId === 'string' &&
    !delivery.workId.startsWith('-');
  if (!validBase) return false;
  const hasWorktreeBranch = typeof delivery.worktreeBranch === 'string';
  const hasWorktreePath = typeof delivery.worktreePath === 'string';
  if (hasWorktreeBranch !== hasWorktreePath) return false;
  const hasWorktree =
    typeof delivery.worktreeBranch === 'string' &&
    typeof delivery.worktreePath === 'string' &&
    isAbsolute(delivery.worktreePath);
  if (hasWorktreePath && !hasWorktree) return false;
  const hasSession = typeof delivery.sessionKey === 'string';
  if (delivery.stage === 'admitted') {
    return (
      delivery.activation === undefined &&
      delivery.acknowledgment === undefined &&
      delivery.worktreeBranch === undefined &&
      delivery.worktreePath === undefined &&
      !hasSession &&
      delivery.sessionId === undefined
    );
  }
  if (delivery.stage === 'worktree-ready') {
    return (
      delivery.activation === undefined &&
      delivery.acknowledgment === undefined &&
      hasWorktree &&
      !hasSession &&
      delivery.sessionId === undefined
    );
  }
  if (delivery.stage === 'session-recording') {
    return (
      delivery.activation === undefined &&
      delivery.acknowledgment === undefined &&
      (itemType === 'pull-request' || hasWorktree) &&
      !hasSession &&
      delivery.sessionId === undefined
    );
  }
  if (delivery.stage === 'received') {
    return (
      (itemType === 'pull-request' || hasWorktree) &&
      hasSession &&
      delivery.activation === undefined &&
      (delivery.acknowledgment === undefined || delivery.acknowledgment.status === 'pending')
    );
  }
  if (delivery.stage === 'active') {
    return (
      (itemType === 'pull-request' || hasWorktree) &&
      hasSession &&
      delivery.activation !== undefined
    );
  }
  return (
    (delivery.worktreeBranch === undefined) === (delivery.worktreePath === undefined) &&
    (delivery.worktreePath === undefined || isAbsolute(delivery.worktreePath)) &&
    (delivery.sessionId === undefined || hasSession)
  );
}

function validItem(value: unknown): value is GitHubNotificationItemState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<GitHubNotificationItemState>;
  return (
    hasOnlyKeys(value, itemKeys) &&
    validItemFields(value as Record<string, unknown>, item) &&
    Number.isSafeInteger(item.itemDatabaseId) &&
    Number(item.itemDatabaseId) > 0 &&
    (item.commentTracking === undefined || validCommentTracking(item.commentTracking)) &&
    (item.itemType === 'issue'
      ? item.pullRequest === undefined
      : item.pullRequest === undefined || validPullRequest(item.pullRequest)) &&
    (item.delivery === undefined || validDelivery(item.delivery, item.itemType!)) &&
    (item.disposition === 'approved'
      ? item.delivery !== undefined && item.delivery.stage !== 'retired'
      : item.disposition === 'retired'
        ? true
        : item.delivery === undefined) &&
    (item.delivery === undefined ||
      (item.assignmentEventNodeId === item.delivery.assignmentEventId &&
        item.delivery.workId === `${item.itemType}-${item.itemDatabaseId}`)) &&
    (item.commentTracking === undefined ||
      item.disposition === 'approved' ||
      item.disposition === 'retired')
  );
}

function validStateFields(value: object): boolean {
  const state = value as Partial<GitHubNotificationMonitorState>;
  return (
    ((state.accountLogin === undefined && state.accountNodeId === undefined) ||
      (typeof state.accountLogin === 'string' &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(state.accountLogin) &&
        validNodeId(state.accountNodeId))) &&
    typeof state.agentId === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/u.test(state.agentId) &&
    typeof state.workspaceDir === 'string' &&
    state.workspaceDir.length > 0 &&
    Number.isSafeInteger(state.failureCount) &&
    Number(state.failureCount) >= 0 &&
    optionalFiniteNumber(state.baselineAt) &&
    optionalFiniteNumber(state.lastPollAt) &&
    optionalFiniteNumber(state.lastSuccessfulPollAt) &&
    optionalFiniteNumber(state.nextPollAt) &&
    (state.diagnosticCode === undefined || typeof state.diagnosticCode === 'string') &&
    (state.searchBoundary === undefined || !Number.isNaN(Date.parse(state.searchBoundary))) &&
    Array.isArray(state.processedEventNodeIds) &&
    state.processedEventNodeIds.length <= 2_000 &&
    state.processedEventNodeIds.every(validNodeId) &&
    new Set(state.processedEventNodeIds).size === state.processedEventNodeIds.length &&
    state.items !== undefined &&
    !Array.isArray(state.items)
  );
}

function validState(value: unknown): value is GitHubNotificationMonitorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<GitHubNotificationMonitorState>;
  return (
    hasOnlyKeys(value, stateKeys) &&
    state.schemaVersion === 3 &&
    validStateFields(value) &&
    state.items !== undefined &&
    Object.entries(state.items).every(
      ([key, item]) => validItem(item) && key === `github:${item.repositoryNodeId}:${item.number}`,
    )
  );
}

/** Drop the removed publication checkpoint map from otherwise valid current state. */
function withoutDeprecatedDeliveryCheckpoints(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const state = value as Record<string, unknown>;
  const items = state.items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) return value;
  let changed = false;
  const normalizedItems: Record<string, unknown> = { ...items };
  for (const [key, candidate] of Object.entries(items)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const delivery = item.delivery;
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) continue;
    if (!Object.hasOwn(delivery, 'progress')) continue;
    const record = delivery as Record<string, unknown>;
    if (!validDeprecatedDeliveryCheckpoints(record.progress)) return value;
    const normalizedDelivery = { ...record };
    delete normalizedDelivery.progress;
    normalizedItems[key] = { ...item, delivery: normalizedDelivery };
    changed = true;
  }
  return changed ? { ...state, items: normalizedItems } : value;
}

/** Validate only the current value-free monitor state contract. */
export default function decodeGitHubNotificationMonitorState(
  value: unknown,
  agentId: string,
): GitHubNotificationMonitorStateDecodeResult | undefined {
  const normalized = withoutDeprecatedDeliveryCheckpoints(value);
  if (validState(normalized) && normalized.agentId === agentId) {
    return { state: normalized, status: 'ready' };
  }
  return undefined;
}
