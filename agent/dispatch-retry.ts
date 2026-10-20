import { providerDiagnosticSchema, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import { Type } from 'typebox';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import workflowFailure from './workflow-failure.ts';

export const dispatchRetryProperties = {
  providerDiagnostic: Type.Optional(providerDiagnosticSchema),
  retry: Type.Optional(
    Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 4096 }),
        attempts: Type.Integer({ minimum: 1, maximum: 5 }),
      },
      { additionalProperties: false },
    ),
  ),
  retryAfter: Type.Optional(Type.Integer({ minimum: 0 })),
};

type RetryState = Pick<SharedDispatchRecord, 'retry' | 'retryAfter'> & {
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
) {
  const diagnostic = workflowFailure(error, code).providerDiagnostic;
  record.providerDiagnostic = diagnostic;
  const retryable =
    !explicitStop(code) &&
    (diagnostic
      ? ['transport', 'rate-limit', 'authentication', 'permission'].includes(
          diagnostic.classification,
        )
      : transient.has(code) || /^git-(?:fetch|clone)-(?:(?:dns|timeout|connection)-)/.test(code));
  if (!retryable) {
    delete record.retry;
    return false;
  }
  const attempts = Math.min(5, (record.retry?.attempts ?? 0) + 1);
  record.retry = { code, attempts };
  record.retryAfter = Math.max(
    now + Math.min(300000 * 2 ** (attempts - 1), 3600000),
    now + (diagnostic?.retryAfterMs ?? 0),
    diagnostic?.resetAt ?? 0,
  );
  return true;
}

export function dispatchRetryDue(record: RetryState, now: number) {
  return Boolean(record.retry && record.retryAfter !== undefined && record.retryAfter <= now);
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
