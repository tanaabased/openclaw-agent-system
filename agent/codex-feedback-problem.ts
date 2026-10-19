import type { DispatchRecord } from './codex-dispatch-state.ts';

/** normal historical closure is quiet only when no execution or publication remains uncertain. */
export default function codexFeedbackProblem(record: DispatchRecord) {
  const feedback = record.feedback;
  if (!feedback?.code) return false;
  if (
    ![
      'dispatch-assignment-authority-revoked',
      'dispatch-issue-closed',
      'dispatch-assignment-removed',
      'dispatch-assignment-superseded',
    ].includes(feedback.code)
  )
    return true;
  return feedback.events.some(
    (event) =>
      ['queued', 'prepared', 'running', 'responded'].includes(event.phase) ||
      (event.publicationAttempted && !event.receipt) ||
      (event.phase === 'blocked' && event.attempt && !record.nativeInactive),
  );
}
