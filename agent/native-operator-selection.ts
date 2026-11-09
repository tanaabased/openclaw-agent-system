import { dispatchAdmission, managedTargetUrl, type ManagedIssue } from './managed-issue.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import { assertNativeContextInput } from './native-context-request.ts';

/** Explicit operator target selection is not proof of authorization; the owner still checks it. */
export default function nativeOperatorSelection<R extends SharedDispatchRecord>(
  input: Record<string, unknown>,
  records: readonly R[],
  admitted: readonly ManagedIssue[],
  caller: string,
) {
  assertNativeContextInput(input);
  const matches = records.filter((record) => {
    if (!input.target) return record.threadId === caller;
    const issue = dispatchAdmission(record, admitted);
    return issue && managedTargetUrl(issue) === input.target;
  });
  if (matches.length !== 1)
    throw new Error(matches.length ? 'dispatch-target-ambiguous' : 'dispatch-target-unavailable');
  return matches[0]!;
}
