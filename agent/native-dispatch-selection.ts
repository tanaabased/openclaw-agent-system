import { automationHash } from './automation-hash.ts';
import { dispatchAdmission, managedTargetUrl, type ManagedIssue } from './managed-issue.ts';
import { routingInstructionsDigest } from './routing-instructions.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { assertNativeContextInput } from './native-context-request.ts';
import type { FeedbackSourceEvent } from './feedback-state.ts';
import { feedbackTarget } from './reply-target.ts';

export function isNativeDispatchSelection(action: unknown) {
  return ['prepare', 'reconcile', 'start', 'assess'].includes(String(action));
}

/** The coordinator chooses an issue, never a journal key or preparation fingerprint. */
export function nativeDispatchSelection<R extends SharedDispatchRecord>(
  input: Record<string, unknown>,
  records: readonly R[],
  admitted: readonly ManagedIssue[],
  caller: string,
) {
  assertNativeContextInput(input);
  if (Object.hasOwn(input, 'receipt')) throw new Error('native-context-binding-override');
  if (input.target !== undefined && typeof input.target !== 'string')
    throw new Error('dispatch-target-invalid');
  const matches = records.filter((record) => {
    if (record.sourceThreadId !== caller || record.reset || record.supersededBy) return false;
    if (record.retired && input.action !== 'reconcile') return false;
    if (!input.target && input.action === 'prepare' && record.phase !== 'routing') return false;
    const issue = dispatchAdmission(record, admitted);
    return issue && (!input.target || managedTargetUrl(issue) === input.target);
  });
  if (matches.length !== 1)
    throw new Error(matches.length ? 'dispatch-target-ambiguous' : 'dispatch-target-unavailable');
  return matches[0]!;
}

/** Internal snapshot check retained across the adapter/owner boundary. */
export function nativeDispatchDigest(
  record: SharedDispatchRecord & { project?: unknown },
  runtime: 'codex' | 'openclaw',
) {
  return automationHash({
    context: record.context,
    ...(record.adoptedPullRequest ? { adoptedPullRequest: record.adoptedPullRequest } : {}),
    ...(runtime === 'codex' ? { project: record.project } : {}),
    manifest: record.manifestDigest,
    instructions:
      record.routingInstructions && routingInstructionsDigest(record.routingInstructions),
  });
}

export function nativeDispatchResponse<T>(
  value: T,
  records: readonly (SharedDispatchRecord & {
    feedback?: { events: readonly FeedbackSourceEvent[] };
  })[],
  admitted: readonly ManagedIssue[],
): T {
  if (!value || typeof value !== 'object' || !('id' in value)) return value;
  const record = records.find((entry) => entry.id === value.id);
  const issue = record && dispatchAdmission(record, admitted);
  const event =
    record && 'eventId' in value
      ? record.feedback?.events.find((event) => event.id === value.eventId)
      : undefined;
  return issue
    ? {
        ...value,
        target: managedTargetUrl(issue),
        ...(event && !('source' in value)
          ? {
              source: feedbackTarget(
                `${issue.repository.owner.login}/${issue.repository.name}`,
                event,
              ),
            }
          : {}),
      }
    : value;
}
