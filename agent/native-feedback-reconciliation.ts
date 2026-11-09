import { dispatchAdmission, type ManagedIssue } from './managed-issue.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import { feedbackTarget, replyLocator } from './reply-target.ts';

/** The coordinator may reconcile its own admitted source; it cannot impersonate an issue turn. */
export default function nativeFeedbackReconciliation(
  records: readonly (SharedDispatchRecord & {
    feedback?: {
      events: readonly (FeedbackSourceEvent & {
        attempt?: unknown;
        turn?: unknown;
        phase?: string;
      })[];
    };
  })[],
  admitted: readonly ManagedIssue[],
  caller: string,
  source: unknown,
) {
  if (source !== undefined && (typeof source !== 'string' || !replyLocator(source).commentId))
    throw new Error('feedback-source-url-required');
  const matches = records.flatMap((record) => {
    if (record.sourceThreadId !== caller) return [];
    const issue = dispatchAdmission(record, admitted);
    if (!issue) return [];
    const repository = `${issue.repository.owner.login}/${issue.repository.name}`;
    return (record.feedback?.events ?? [])
      .filter((event) =>
        source
          ? feedbackTarget(repository, event) === source
          : (event.attempt || event.turn) && event.phase !== 'delivered',
      )
      .map((event) => ({ id: record.id, eventId: event.id }));
  });
  if (matches.length !== 1)
    throw new Error(matches.length ? 'feedback-source-ambiguous' : 'feedback-source-not-admitted');
  return matches[0]!;
}
