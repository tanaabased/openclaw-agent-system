import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { ProviderDiagnostic } from '../utils/provider-diagnostic.ts';

const transient = new Set([
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
  record: SharedDispatchRecord,
  code: string,
  error: unknown,
  now: number,
) {
  const diagnostic = (error as { providerDiagnostic?: ProviderDiagnostic } | null)
    ?.providerDiagnostic;
  const retryable = diagnostic
    ? ['transport', 'rate-limit'].includes(diagnostic.classification)
    : transient.has(code);
  if (!retryable) {
    delete record.retry;
    return false;
  }
  const attempts = Math.min(5, (record.retry?.attempts ?? 0) + 1);
  record.retry = { code, attempts };
  if (attempts >= 5) delete record.retryAfter;
  else
    record.retryAfter = Math.max(
      now + Math.min(300000 * 2 ** (attempts - 1), 3600000),
      now + (diagnostic?.retryAfterMs ?? 0),
      diagnostic?.resetAt ?? 0,
    );
  return true;
}

export function dispatchRetryDue(record: SharedDispatchRecord, now: number) {
  return Boolean(
    record.retry &&
    record.retry.attempts < 5 &&
    record.retryAfter !== undefined &&
    record.retryAfter <= now,
  );
}
