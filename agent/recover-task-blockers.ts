import type { AssessmentResult } from './assessment-result.ts';

const obsolete = new Set([
  'dispatch-policy-changed',
  'dispatch-assignment-actor-not-allowed',
  'dispatch-assignment-actor-type-changed',
  'dispatch-repository-owner-not-allowed',
  'dispatch-repository-owner-changed',
  'dispatch-repository-name-changed',
  'dispatch-repository-archived',
  'dispatch-repository-disabled',

  'dispatch-activation-required',
  'workflow-schedule-reconciliation-required',
  'continuation-authority-changed',
  'continuation-assessment-evidence-changed',
  'continuation-assessment-evidence-incomplete',
  'feedback-authority-changed',
  'feedback-authority-revoked',
  'delivery-schedule-stale',
  'dispatch-operator-followup-required',
  'dispatch-handoff-user-turn-required',
  'dispatch-implementation-authorization-required',
  'delivery-human-publication-required',
  'feedback-work-authority-denied',
  'feedback-composition-interrupted',
  'feedback-publication-interrupted',
  'feedback-turn-ended',
  'continuation-user-intervened',
  'continuation-selection-changed',
  'continuation-skill-identity-changed',
  'dispatch-assessment-skill-changed',
  'continuation-schedule-binding-mismatch',
  'feedback-schedule-owner-changed',
]);

/** normalize supported active records without granting new work or replaying any effect. */
export default function recoverTaskBlockers(record: {
  request?: unknown;
  threadId?: string;
  worktree?: string;
  effective?: { status: string };
  retired?: unknown;
  retirement?: unknown;
  reset?: unknown;
  phase: string;
  result?: AssessmentResult;
  blocker?: string;
  retryAfter?: number;
  retry?: unknown;
  compatibilityRecovery?: { version: 1; codes: string[]; previousResult?: AssessmentResult };
  continuation?: {
    phase: string;
    code?: string;
    attempt?: unknown;
    binding?: unknown;
    result?: { outcome: string };
    publicationAttempt?: unknown;
    retry?: unknown;
    retryAfter?: number;
  };
  feedback?: {
    events: Array<{
      phase: string;
      code?: string;
      retry?: unknown;
      retryAfter?: number;
      turn?: unknown;
      attempt?: unknown;
      publicationAttempted?: boolean;
      result?: { privateText?: string; publicText?: string };
    }>;
  };
}) {
  if (
    !record.request ||
    !record.threadId ||
    !record.worktree ||
    record.effective?.status !== 'verified' ||
    record.retired ||
    record.retirement ||
    record.reset
  )
    return;
  const retain = (code: string) => {
    record.compatibilityRecovery ??= { version: 1, codes: [] };
    if (!record.compatibilityRecovery.codes.includes(code))
      record.compatibilityRecovery.codes.push(code);
  };
  const clear = (entry: { code?: string; retry?: unknown; retryAfter?: number }) => {
    retain(entry.code!);
    delete entry.code;
    delete entry.retry;
    delete entry.retryAfter;
  };
  if (record.result?.outcome === 'operator-setup-blocker' && obsolete.has(record.result.code)) {
    retain(record.result.code);
    record.compatibilityRecovery!.previousResult = record.result;
    delete record.result;
    record.phase = 'assessing';
  }
  if (record.blocker && obsolete.has(record.blocker)) {
    retain(record.blocker);
    delete record.blocker;
    delete record.retry;
    delete record.retryAfter;
    if (record.phase === 'blocked') record.phase = record.result ? 'complete' : 'assessing';
  }
  const work = record.continuation;
  if (work?.phase === 'blocked' && work.code && obsolete.has(work.code)) {
    clear(work);
    work.phase =
      work.result?.outcome === 'clarification-needed' || work.result?.outcome === 'blocked'
        ? work.result.outcome
        : work.publicationAttempt || work.result?.outcome === 'done'
          ? 'delivery'
          : work.binding
            ? 'running'
            : work.attempt
              ? 'prepared'
              : 'waiting';
  }
  for (const event of record.feedback?.events ?? []) {
    if (event.code === 'feedback-composition-changed' && !event.publicationAttempted) {
      if (event.result) delete event.result.publicText;
      delete event.code;
      event.phase = event.turn || event.attempt ? 'running' : 'queued';
    }
    if (
      event.phase === 'blocked' &&
      event.code &&
      (obsolete.has(event.code) ||
        ['github-notification-request-failed', 'github-account-credential-unavailable'].includes(
          event.code,
        ))
    ) {
      clear(event);
      // submitted operations must be reconciled by their existing receipt, never queued again.
      event.phase = event.publicationAttempted
        ? 'responded'
        : event.turn || event.attempt
          ? 'running'
          : 'queued';
    }
  }
}
