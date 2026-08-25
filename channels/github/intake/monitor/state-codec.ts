import { isAbsolute } from 'node:path';

import type {
  GitHubNotificationIntakeState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from './state.ts';

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

const sharedItemKeys = [
  'assignmentActorLogin',
  'assignmentActorNodeId',
  'assignmentEventNodeId',
  'disposition',
  'itemDatabaseId',
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
] as const;

const itemKeys = new Set([...sharedItemKeys, 'intake', 'lifecycleId']);
const intakeKeys = new Set([
  'assignmentEventId',
  'cleanup',
  'failureCode',
  'providerRetirementVerifiedAt',
  'stage',
  'worktreeBranch',
  'worktreePath',
]);
const pullRequestKeys = new Set([
  'authorNodeId',
  'baseRef',
  'draft',
  'headRef',
  'headRepositoryDatabaseId',
  'headRepositoryNodeId',
  'headSha',
]);

const legacyItemKeys = new Set([...sharedItemKeys, 'commentTracking', 'delivery']);
const legacyDeliveryKeys = new Set([
  'activation',
  'acknowledgment',
  'assignmentEventId',
  'failureCode',
  'mode',
  'progress',
  'schemaVersion',
  'sessionId',
  'sessionKey',
  'stage',
  'workId',
  'worktreeBranch',
  'worktreePath',
]);
const legacyStages = new Set([
  'active',
  'admitted',
  'received',
  'retired',
  'session-recording',
  'worktree-ready',
]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
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

function optionalBoundedString(value: unknown, maximumLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maximumLength &&
      !hasControlCharacter(value))
  );
}

function validDiagnosticCode(value: unknown): boolean {
  return (
    value === undefined ||
    (optionalBoundedString(value, 255) && /^[a-z0-9][a-z0-9-]*$/u.test(String(value)))
  );
}

function validCleanup(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      hasOnlyKeys(value, new Set(['reasonCode', 'session', 'status', 'worktree'])) &&
      validDiagnosticCode(value.reasonCode) &&
      value.reasonCode !== undefined &&
      ['archived', 'failed', 'missing', 'pinned'].includes(String(value.session)) &&
      ['completed', 'failed', 'skipped'].includes(String(value.status)) &&
      ['dirty', 'failed', 'missing', 'not-applicable', 'removed', 'unsafe'].includes(
        String(value.worktree),
      ))
  );
}

function validPullRequest(value: unknown): boolean {
  if (!record(value) || !hasOnlyKeys(value, pullRequestKeys)) return false;
  const hasHeadRepositoryDatabaseId = value.headRepositoryDatabaseId !== undefined;
  const hasHeadRepositoryNodeId = value.headRepositoryNodeId !== undefined;
  return (
    (value.authorNodeId === undefined || validNodeId(value.authorNodeId)) &&
    optionalBoundedString(value.baseRef, 255) &&
    typeof value.baseRef === 'string' &&
    typeof value.draft === 'boolean' &&
    optionalBoundedString(value.headRef, 255) &&
    typeof value.headRef === 'string' &&
    hasHeadRepositoryDatabaseId === hasHeadRepositoryNodeId &&
    (value.headRepositoryDatabaseId === undefined ||
      (Number.isSafeInteger(value.headRepositoryDatabaseId) &&
        Number(value.headRepositoryDatabaseId) > 0)) &&
    (value.headRepositoryNodeId === undefined || validNodeId(value.headRepositoryNodeId)) &&
    typeof value.headSha === 'string' &&
    /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.headSha)
  );
}

function validItemFields(item: Record<string, unknown>): boolean {
  return (
    ['approved', 'baseline', 'rejected', 'retired'].includes(String(item.disposition)) &&
    validNodeId(item.itemNodeId) &&
    (item.itemType === 'issue' || item.itemType === 'pull-request') &&
    typeof item.lastObservedAt === 'number' &&
    Number.isFinite(item.lastObservedAt) &&
    Number.isSafeInteger(item.itemDatabaseId) &&
    Number(item.itemDatabaseId) > 0 &&
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
      String(item.repositoryPermission),
    ) &&
    (item.assignmentActorNodeId === undefined || validNodeId(item.assignmentActorNodeId)) &&
    (item.assignmentActorLogin === undefined ||
      (typeof item.assignmentActorLogin === 'string' &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(item.assignmentActorLogin))) &&
    (item.assignmentEventNodeId === undefined || validNodeId(item.assignmentEventNodeId)) &&
    (item.itemType === 'issue'
      ? item.pullRequest === undefined
      : item.pullRequest === undefined || validPullRequest(item.pullRequest))
  );
}

function validWorktree(value: Record<string, unknown>): boolean {
  const hasBranch = typeof value.worktreeBranch === 'string';
  const hasPath = typeof value.worktreePath === 'string';
  return (
    hasBranch === hasPath &&
    (!hasPath ||
      (optionalBoundedString(value.worktreeBranch, 255) &&
        optionalBoundedString(value.worktreePath, 4_096) &&
        isAbsolute(String(value.worktreePath))))
  );
}

function validIntake(
  value: unknown,
  item: Record<string, unknown>,
): value is GitHubNotificationIntakeState {
  if (!record(value) || !hasOnlyKeys(value, intakeKeys)) return false;
  if (
    !validNodeId(value.assignmentEventId) ||
    !validCleanup(value.cleanup) ||
    !validDiagnosticCode(value.failureCode) ||
    !optionalFiniteNumber(value.providerRetirementVerifiedAt) ||
    !['admitted', 'prepared', 'retired'].includes(String(value.stage)) ||
    !validWorktree(value)
  ) {
    return false;
  }
  const hasWorktree = typeof value.worktreePath === 'string';
  if (
    value.stage !== 'retired' &&
    (value.cleanup !== undefined || value.providerRetirementVerifiedAt !== undefined)
  ) {
    return false;
  }
  if (value.cleanup !== undefined && value.providerRetirementVerifiedAt === undefined) return false;
  if (value.stage === 'admitted') return !hasWorktree;
  if (value.stage === 'prepared' && item.lifecycleId === 'issue') return hasWorktree;
  if (value.stage === 'prepared') return !hasWorktree;
  return true;
}

function lifecycleMatchesItem(item: Record<string, unknown>): boolean {
  return item.lifecycleId === 'issue'
    ? item.itemType === 'issue'
    : (item.lifecycleId === 'pull-request' || item.lifecycleId === 'pull-request-review') &&
        item.itemType === 'pull-request';
}

function validItem(value: unknown): value is GitHubNotificationItemState {
  if (!record(value) || !hasOnlyKeys(value, itemKeys) || !validItemFields(value)) return false;
  if (!lifecycleMatchesItem(value)) return false;
  const intakeValid = value.intake === undefined || validIntake(value.intake, value);
  if (!intakeValid) return false;
  if (value.disposition === 'approved') {
    if (!record(value.intake) || value.intake.stage === 'retired') return false;
  } else if (value.disposition !== 'retired' && value.intake !== undefined) {
    return false;
  }
  return (
    value.intake === undefined ||
    (record(value.intake) && value.assignmentEventNodeId === value.intake.assignmentEventId)
  );
}

function validStateFields(value: Record<string, unknown>): boolean {
  return (
    ((value.accountLogin === undefined && value.accountNodeId === undefined) ||
      (typeof value.accountLogin === 'string' &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(value.accountLogin) &&
        validNodeId(value.accountNodeId))) &&
    typeof value.agentId === 'string' &&
    /^[a-z0-9][a-z0-9-]*$/u.test(value.agentId) &&
    typeof value.workspaceDir === 'string' &&
    value.workspaceDir.length > 0 &&
    Number.isSafeInteger(value.failureCount) &&
    Number(value.failureCount) >= 0 &&
    optionalFiniteNumber(value.baselineAt) &&
    optionalFiniteNumber(value.lastPollAt) &&
    optionalFiniteNumber(value.lastSuccessfulPollAt) &&
    optionalFiniteNumber(value.nextPollAt) &&
    (value.diagnosticCode === undefined || typeof value.diagnosticCode === 'string') &&
    (value.searchBoundary === undefined ||
      (typeof value.searchBoundary === 'string' &&
        !Number.isNaN(Date.parse(value.searchBoundary)))) &&
    Array.isArray(value.processedEventNodeIds) &&
    value.processedEventNodeIds.length <= 2_000 &&
    value.processedEventNodeIds.every(validNodeId) &&
    new Set(value.processedEventNodeIds).size === value.processedEventNodeIds.length &&
    record(value.items)
  );
}

function validCurrentState(value: unknown): value is GitHubNotificationMonitorState {
  if (!record(value) || !hasOnlyKeys(value, stateKeys) || value.schemaVersion !== 5) return false;
  return (
    validStateFields(value) &&
    record(value.items) &&
    Object.entries(value.items).every(
      ([key, item]) => validItem(item) && key === `github:${item.repositoryNodeId}:${item.number}`,
    )
  );
}

function validLegacyDelivery(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    hasOnlyKeys(value, legacyDeliveryKeys) &&
    value.schemaVersion === 1 &&
    validNodeId(value.assignmentEventId) &&
    validDiagnosticCode(value.failureCode) &&
    legacyStages.has(String(value.stage)) &&
    validWorktree(value)
  );
}

function legacyIntake(
  item: Record<string, unknown>,
  delivery: Record<string, unknown>,
): GitHubNotificationIntakeState {
  const hasWorktree =
    typeof delivery.worktreeBranch === 'string' && typeof delivery.worktreePath === 'string';
  const stage =
    item.disposition === 'retired' || delivery.stage === 'retired'
      ? 'retired'
      : item.itemType === 'issue' && !hasWorktree
        ? 'admitted'
        : 'prepared';
  return {
    assignmentEventId: String(delivery.assignmentEventId),
    ...(delivery.failureCode === undefined ? {} : { failureCode: String(delivery.failureCode) }),
    stage,
    ...(hasWorktree
      ? {
          worktreeBranch: String(delivery.worktreeBranch),
          worktreePath: String(delivery.worktreePath),
        }
      : {}),
  };
}

function migrateLegacyItem(value: unknown): GitHubNotificationItemState | undefined {
  if (!record(value) || !hasOnlyKeys(value, legacyItemKeys) || !validItemFields(value)) {
    return undefined;
  }
  const delivery = value.delivery;
  if (delivery !== undefined && !validLegacyDelivery(delivery)) return undefined;
  if (value.disposition === 'approved' && !record(delivery)) return undefined;
  if (
    value.disposition !== 'approved' &&
    value.disposition !== 'retired' &&
    delivery !== undefined
  ) {
    return undefined;
  }
  if (record(delivery) && value.assignmentEventNodeId !== delivery.assignmentEventId) {
    return undefined;
  }
  const item = Object.fromEntries(
    sharedItemKeys.map((key) => [key, value[key]]).filter(([, field]) => field !== undefined),
  ) as unknown as GitHubNotificationItemState;
  item.lifecycleId = item.itemType;
  if (record(delivery)) item.intake = legacyIntake(value, delivery);
  return validItem(item) ? item : undefined;
}

function migrateSchemaThree(value: unknown): GitHubNotificationMonitorState | undefined {
  if (
    !record(value) ||
    !hasOnlyKeys(value, stateKeys) ||
    value.schemaVersion !== 3 ||
    !validStateFields(value) ||
    !record(value.items)
  ) {
    return undefined;
  }
  const items: Record<string, GitHubNotificationItemState> = {};
  for (const [key, candidate] of Object.entries(value.items)) {
    const item = migrateLegacyItem(candidate);
    if (!item || key !== `github:${item.repositoryNodeId}:${item.number}`) return undefined;
    items[key] = item;
  }
  const state = {
    ...Object.fromEntries(
      [...stateKeys]
        .filter((key) => key !== 'items' && key !== 'schemaVersion')
        .map((key) => [key, value[key]])
        .filter(([, field]) => field !== undefined),
    ),
    items,
    schemaVersion: 5,
  };
  return validCurrentState(state) ? state : undefined;
}

function migrateSchemaFour(value: unknown): GitHubNotificationMonitorState | undefined {
  if (!record(value) || value.schemaVersion !== 4) return undefined;
  const migrated = { ...value, schemaVersion: 5 };
  return validCurrentState(migrated) ? migrated : undefined;
}

/** Validate current state or project supported legacy intake facts into schema five. */
export default function decodeGitHubNotificationMonitorState(
  value: unknown,
  agentId: string,
): GitHubNotificationMonitorStateDecodeResult | undefined {
  const state = validCurrentState(value)
    ? value
    : (migrateSchemaFour(value) ?? migrateSchemaThree(value));
  return state?.agentId === agentId ? { state, status: 'ready' } : undefined;
}
