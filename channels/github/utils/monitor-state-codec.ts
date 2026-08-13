import { isAbsolute } from 'node:path';

import {
  migrateGitHubNotificationMonitorStateV1,
  type GitHubNotificationDeliveryState,
  type GitHubNotificationItemState,
  type GitHubNotificationItemStateV1,
  type GitHubNotificationMonitorState,
  type GitHubNotificationMonitorStateV1,
} from './monitor-state.ts';

export type GitHubNotificationMonitorStateDecodeResult = {
  state: GitHubNotificationMonitorState;
  status: 'migrated-v1' | 'ready';
};

const stateKeys = new Set([
  'accountLogin',
  'accountNodeId',
  'agentId',
  'baselineAt',
  'baselineItemNodeIds',
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

const legacyItemKeys = new Set([
  'assignmentActorNodeId',
  'assignmentEventNodeId',
  'disposition',
  'itemNodeId',
  'itemType',
  'lastObservedAt',
  'number',
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

const itemKeys = new Set([...legacyItemKeys, 'delivery', 'itemDatabaseId']);

const deliveryKeys = new Set([
  'acknowledgment',
  'assignmentEventId',
  'failureCode',
  'schemaVersion',
  'sessionId',
  'sessionKey',
  'stage',
  'workId',
  'worktreeBranch',
  'worktreePath',
]);

const acknowledgmentKeys = new Set(['commentId', 'status']);

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
  item: Partial<GitHubNotificationItemStateV1>,
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

function validAcknowledgment(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const acknowledgment = value as { commentId?: unknown; status?: unknown };
  if (!hasOnlyKeys(value, acknowledgmentKeys)) return false;
  if (acknowledgment.status === 'pending') return acknowledgment.commentId === undefined;
  return (
    acknowledgment.status === 'published' &&
    Number.isSafeInteger(acknowledgment.commentId) &&
    Number(acknowledgment.commentId) > 0
  );
}

function validDelivery(value: unknown): value is GitHubNotificationDeliveryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const delivery = value as Partial<GitHubNotificationDeliveryState>;
  const validBase =
    hasOnlyKeys(value, deliveryKeys) &&
    delivery.schemaVersion === 1 &&
    (delivery.acknowledgment === undefined || validAcknowledgment(delivery.acknowledgment)) &&
    validNodeId(delivery.assignmentEventId) &&
    ['active', 'admitted', 'retired', 'session-recording', 'worktree-ready'].includes(
      delivery.stage ?? '',
    ) &&
    optionalBoundedString(delivery.failureCode, 255) &&
    (delivery.failureCode === undefined || /^[a-z0-9][a-z0-9-]*$/u.test(delivery.failureCode)) &&
    optionalBoundedString(delivery.sessionId, 255) &&
    optionalBoundedString(delivery.sessionKey, 1_024) &&
    optionalBoundedString(delivery.workId, 256) &&
    optionalBoundedString(delivery.worktreeBranch, 255) &&
    optionalBoundedString(delivery.worktreePath, 4_096) &&
    typeof delivery.workId === 'string' &&
    !delivery.workId.startsWith('-');
  if (!validBase) return false;
  const hasWorktree =
    typeof delivery.worktreeBranch === 'string' &&
    typeof delivery.worktreePath === 'string' &&
    isAbsolute(delivery.worktreePath);
  const hasSession = typeof delivery.sessionKey === 'string';
  if (delivery.stage === 'admitted') {
    return (
      delivery.worktreeBranch === undefined &&
      delivery.worktreePath === undefined &&
      !hasSession &&
      delivery.sessionId === undefined
    );
  }
  if (['session-recording', 'worktree-ready'].includes(delivery.stage ?? '')) {
    return hasWorktree && !hasSession && delivery.sessionId === undefined;
  }
  if (delivery.stage === 'active') {
    return hasWorktree && hasSession;
  }
  return (
    (delivery.worktreeBranch === undefined) === (delivery.worktreePath === undefined) &&
    (delivery.worktreePath === undefined || isAbsolute(delivery.worktreePath)) &&
    (delivery.sessionId === undefined || hasSession)
  );
}

function validLegacyItem(value: unknown): value is GitHubNotificationItemStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (
    hasOnlyKeys(value, legacyItemKeys) &&
    validItemFields(value as Record<string, unknown>, value as GitHubNotificationItemStateV1)
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
    (item.delivery === undefined || validDelivery(item.delivery)) &&
    (item.disposition === 'approved'
      ? item.delivery !== undefined && item.delivery.stage !== 'retired'
      : item.disposition === 'retired'
        ? true
        : item.delivery === undefined) &&
    (item.delivery === undefined ||
      (item.assignmentEventNodeId === item.delivery.assignmentEventId &&
        item.delivery.workId === `${item.itemType}-${item.itemDatabaseId}`))
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
    Array.isArray(state.baselineItemNodeIds) &&
    state.baselineItemNodeIds.length <= 2_000 &&
    state.baselineItemNodeIds.every(validNodeId) &&
    new Set(state.baselineItemNodeIds).size === state.baselineItemNodeIds.length &&
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
    state.schemaVersion === 2 &&
    validStateFields(value) &&
    state.items !== undefined &&
    Object.entries(state.items).every(
      ([key, item]) => validItem(item) && key === `github:${item.repositoryNodeId}:${item.number}`,
    )
  );
}

function validLegacyState(value: unknown): value is GitHubNotificationMonitorStateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<GitHubNotificationMonitorStateV1>;
  return (
    hasOnlyKeys(value, stateKeys) &&
    state.schemaVersion === 1 &&
    validStateFields(value) &&
    state.items !== undefined &&
    Object.entries(state.items).every(
      ([key, item]) =>
        validLegacyItem(item) && key === `github:${item.repositoryNodeId}:${item.number}`,
    )
  );
}

/** Validate current state or explicitly migrate a valid Phase 1 record. */
export default function decodeGitHubNotificationMonitorState(
  value: unknown,
  agentId: string,
): GitHubNotificationMonitorStateDecodeResult | undefined {
  if (validState(value) && value.agentId === agentId) {
    return { state: value, status: 'ready' };
  }
  if (validLegacyState(value) && value.agentId === agentId) {
    return { state: migrateGitHubNotificationMonitorStateV1(value), status: 'migrated-v1' };
  }
  return undefined;
}
