import { providerDiagnosticSchema, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import { Type } from 'typebox';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import workflowFailure from './workflow-failure.ts';
import AgentSystemToolError from '../api/error.ts';

export const dispatchRetryLimit = 5;

export function dispatchRetryDeadline(
  attempts: number,
  now: number,
  diagnostic?: ProviderDiagnostic,
  recheck = false,
) {
  return Math.max(
    now + (recheck ? 300000 : Math.min(300000 * 2 ** (attempts - 1), 3600000)),
    now + (diagnostic?.retryAfterMs ?? 0),
    diagnostic?.resetAt ?? 0,
  );
}

export const dispatchRetryProperties = {
  providerDiagnostic: Type.Optional(providerDiagnosticSchema),
  retry: Type.Optional(
    Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 4096 }),
        attempts: Type.Integer({ minimum: 1, maximum: dispatchRetryLimit }),
      },
      { additionalProperties: false },
    ),
  ),
  retryAfter: Type.Optional(Type.Integer({ minimum: 0 })),
};

type RetryState = Pick<SharedDispatchRecord, 'retry' | 'retryAfter' | 'blocker'> & {
  providerDiagnostic?: ProviderDiagnostic;
};

const transient = new Set([
  'continuation-host-unavailable',
  'feedback-provider-unavailable',
  'dispatch-host-unavailable',
  'session-dispatch-connect-failed',
  'session-dispatch-connect-timeout',
  'session-dispatch-transport-unavailable',
  'private-state-file-lock-busy',
  'private-state-file-lock-lost',
  'github-account-rate-limited',
  'intake-provider-unavailable',
]);

// these owners can inspect repaired prerequisites or reconcile retained native intent.
// rechecking never authorizes replay of an uncertain creation or a native denial.
const recheckable = new Set([
  'dispatch-routing-unresolved',
  'model-routing-not-configured',
  'model-routing-profile-missing',
  'model-routing-instructions-changed',
  'model-routing-xhigh-unjustified',
  'codex-model-provider-unsupported',
  'dispatch-configured-project-missing',
  'dispatch-assessment-skill-ambiguous',
  'dispatch-assessment-skill-unreadable',
  'dispatch-project-inventory-invalid',
  'dispatch-project-inventory-unavailable',
  'dispatch-project-workspace-required',
  'dispatch-project-ambiguous',
  'dispatch-project-registration-unavailable',
  'dispatch-assessment-skill-unavailable',
  'dispatch-assessment-guidance-unreadable',
  'workflow-stage-skill-unavailable',
  'dispatch-creation-unresolved',
  'dispatch-assignment-superseded',
]);

// Only repository preparation can re-run these guards and reconcile its retained Git attempt.
// Identity/ownership conflicts and submitted native effects are deliberately outside this scope.
const repositoryPrerequisites = new Set([
  'dispatch-project-path-unsafe',
  'dispatch-starting-ref-invalid',
  'dispatch-project-git-unavailable',
  'repository-git-unavailable',
  'repository-path-unsafe',
  'repository-path-missing',
  'repository-clone-interrupted',
  'repository-workspace-interrupted',
  'repository-io-unavailable',
]);

/** keep repairable local I/O failures identifiable across saved preparation attempts. */
export function repositoryPreparationFailure(error: unknown) {
  const failure =
    error instanceof AgentSystemToolError &&
    error.code === 'execution_failed' &&
    error.cause instanceof Error
      ? error.cause
      : error;
  const code =
    failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined;
  return typeof code === 'string' &&
    [
      'ENOSPC',
      'EDQUOT',
      'EROFS',
      'EMFILE',
      'ENFILE',
      'EIO',
      'EBUSY',
      'ENOENT',
      'EEXIST',
      'ENOTDIR',
    ].includes(code)
    ? new Error('repository-io-unavailable', { cause: failure })
    : failure;
}

export function dispatchRecheckable(code: string | undefined, repositoryPreparation = false) {
  return (
    code !== undefined &&
    (recheckable.has(code) ||
      (repositoryPreparation &&
        (repositoryPrerequisites.has(code) || /^git-[a-z-]+-exit-(?:\d+|terminated)$/.test(code))))
  );
}

function explicitStop(code: string) {
  return (
    /-(?:cancelled|authority-revoked)$/.test(code) ||
    (code.endsWith('-denied') && !/^(?:github|git)-/.test(code))
  );
}

/** retry reads and preparation; retained native intents still require reconciliation. */
export function scheduleDispatchRetry(
  record: RetryState,
  code: string,
  error: unknown,
  now: number,
  repositoryPreparation = false,
) {
  const diagnostic = workflowFailure(error, code).providerDiagnostic;
  record.providerDiagnostic = diagnostic;
  // Git may classify local locks, disk failures, and configuration errors as unknown.
  const recheck =
    dispatchRecheckable(code, repositoryPreparation) &&
    (!diagnostic ||
      ((code === 'dispatch-project-inventory-unavailable' ||
        (repositoryPreparation && diagnostic.provider === 'git')) &&
        diagnostic.classification === 'unknown'));
  const retryable =
    !explicitStop(code) &&
    (recheck ||
      (diagnostic
        ? ['transport', 'rate-limit', 'authentication', 'permission'].includes(
            diagnostic.classification,
          )
        : transient.has(code) ||
          /^git-(?:fetch|clone)-(?:(?:dns|timeout|connection)-)/.test(code)));
  if (!retryable) {
    delete record.retry;
    delete record.retryAfter;
    return false;
  }
  const attempts = Math.min(dispatchRetryLimit, (record.retry?.attempts ?? 0) + 1);
  record.retry = { code, attempts };
  record.retryAfter = dispatchRetryDeadline(attempts, now, diagnostic, recheck);
  return true;
}

export function dispatchRetryDue(record: RetryState, now: number, repositoryPreparation = false) {
  return record.retry
    ? record.retryAfter !== undefined && record.retryAfter <= now
    : dispatchRecheckable(record.blocker, repositoryPreparation);
}

/** durable stops name an actual authority or task decision; uncertainty is waiting. */
export function dispatchFailurePhase(record: RetryState, code: string, error?: unknown) {
  if (explicitStop(code)) return 'blocked' as const;
  const diagnostic = workflowFailure(error, code).providerDiagnostic;
  if (diagnostic && ['permission', 'authentication'].includes(diagnostic.classification))
    return record.retry ? ('retrying' as const) : ('waiting' as const);
  if (
    /-(?:denied|cancelled|authority-revoked)$/.test(code) ||
    /^delivery-(?:repository|issue|session|thread|worktree|branch|base|account|policy)-changed$/.test(
      code,
    ) ||
    /^dispatch-(?:receiver-account-changed|repository-(?:identity-changed|archived|disabled|owner-changed|name-changed|owner-not-allowed)|issue-(?:identity-changed|type-changed|closed)|assignment-(?:removed|actor-type-changed|actor-not-allowed|actor-changed))$/.test(
      code,
    ) ||
    [
      'feedback-source-identity-changed',
      'feedback-source-author-changed',
      'feedback-source-no-longer-eligible',
      'dispatch-assignment-superseded',
      'dispatch-workspace-binding-changed',
      'dispatch-issue-inactive',
      'dispatch-assessment-handed-off',
      'dispatch-reset-pending',
      'dispatch-policy-disabled',
      'dispatch-turn-failed',
      'dispatch-session-binding-changed',
      'dispatch-native-model-diverged',
      'dispatch-native-receipt-reused',
      'authority-revoked',
      'continuation-native-binding-mismatch',
      'continuation-assessment-changed',
      'continuation-assessment-selection-changed',
      'continuation-turn-changed',
      'continuation-denial-context-changed',
      'continuation-retry-context-changed',
    ].includes(code)
  )
    return 'blocked' as const;
  return record.retry ? ('retrying' as const) : ('waiting' as const);
}

/** Waiting after an unclassified failure has no automatic wake-up contract. */
export function dispatchFailureStatus(record: RetryState, code: string, error?: unknown) {
  const phase = dispatchFailurePhase(record, code, error);
  return phase === 'waiting' ? 'needs-attention' : phase;
}
