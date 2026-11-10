import { dispatchAdmission, managedTargetUrl, type ManagedIssue } from './managed-issue.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { assertNativeContextInput } from './native-context-request.ts';

/** Explicit operator target selection is not proof of authorization; the owner still checks it. */
export default function nativeOperatorSelection<R extends SharedDispatchRecord>(
  input: Record<string, unknown>,
  records: readonly R[],
  admitted: readonly ManagedIssue[],
  caller: string,
  invocation?: { turnId: string; inputId: string },
) {
  assertNativeContextInput(input);
  const matches = records.filter((record) => {
    if (
      input.action === 'retry' &&
      (record.retired || record.retirement || record.reset || record.supersededBy)
    )
      return false;
    if (input.chat && record.threadId !== input.chat) return false;
    if (input.chat && !input.target) return true;
    if (!input.target) return record.threadId === caller;
    const issue = dispatchAdmission(record, admitted);
    return issue && managedTargetUrl(issue) === input.target;
  });
  if (input.action === 'recover' && invocation) {
    const resumed = matches.filter(
      (record) =>
        record.recovery?.by === caller &&
        record.recovery.turnId === invocation.turnId &&
        record.recovery.inputId === invocation.inputId,
    );
    if (resumed.length === 1) return resumed[0]!;
  }
  if (matches.length !== 1)
    throw new Error(matches.length ? 'dispatch-target-ambiguous' : 'dispatch-target-unavailable');
  return matches[0]!;
}
