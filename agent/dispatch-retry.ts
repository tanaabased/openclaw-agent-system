import { Type } from 'typebox';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import workflowFailure from './workflow-failure.ts';

export const dispatchRetryProperties = {
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

type RetryState = Pick<SharedDispatchRecord, 'retry' | 'retryAfter'>;

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

/** retry reads and preparation; retained native intents still require reconciliation. */
export function scheduleDispatchRetry(
  record: RetryState,
  code: string,
  error: unknown,
  now: number,
) {
  const diagnostic = workflowFailure(error, code).providerDiagnostic;
  const retryable = diagnostic
    ? ['transport', 'rate-limit'].includes(diagnostic.classification)
    : transient.has(code) || /^git-(?:fetch|clone)-(?:(?:dns|timeout|connection)-)/.test(code);
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
  const diagnostic = workflowFailure(error, code).providerDiagnostic;
  if (diagnostic && ['permission', 'authentication'].includes(diagnostic.classification))
    return 'blocked' as const;
  if (
    /-(?:denied|cancelled|authority-revoked)$/.test(code) ||
    [
      'dispatch-assignment-superseded',
      'dispatch-policy-changed',
      'dispatch-policy-disabled',
      'dispatch-turn-failed',
      'dispatch-session-binding-changed',
      'dispatch-native-model-diverged',
      'dispatch-native-receipt-reused',
      'authority-revoked',
      'continuation-authority-changed',
      'continuation-native-binding-mismatch',
      'continuation-assessment-changed',
      'continuation-assessment-selection-changed',
      'continuation-assessment-evidence-changed',
      'continuation-selection-changed',
      'continuation-turn-changed',
      'continuation-user-intervened',
    ].includes(code)
  )
    return 'blocked' as const;
  return record.retry ? ('retrying' as const) : ('waiting' as const);
}
