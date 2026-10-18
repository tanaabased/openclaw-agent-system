import { providerDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';

/** match recovery to observed failure evidence rather than guessing at credential problems. */
export default function workflowRecovery(code: string, diagnostic?: ProviderDiagnostic) {
  if (diagnostic) {
    const safe = providerDiagnostic(
      diagnostic.provider,
      diagnostic.operation,
      diagnostic.classification,
      diagnostic,
    );
    return {
      summary: safe.explanation,
      next:
        safe.classification === 'unknown'
          ? 'Inspect the diagnostic for this provider operation and reconcile any uncertain write using its retained receipt. No authentication or permission failure was established; do not change credentials on this evidence.'
          : safe.explanation +
            ' Preserve the existing work and reconcile any uncertain write before retrying this operation.',
    };
  }
  const reasons: Record<string, [string, string]> = {
    'dispatch-receiver-account-changed': [
      'The current GitHub account differs from the admitted receiver.',
      'Select the admitted GitHub account or explicitly reconcile the intended account change. Keep the existing issue chat.',
    ],
    'dispatch-repository-identity-changed': [
      'GitHub returned a different repository identity.',
      'Verify the repository ID and destination against the retained assignment before continuing.',
    ],
    'dispatch-repository-owner-changed': [
      'The repository owner changed.',
      'Verify the transfer and configured repository owner before reconciling the retained assignment.',
    ],
    'dispatch-repository-name-changed': [
      'The repository name changed.',
      'Verify the rename and checkout origin, then reconcile the retained assignment with its current repository destination.',
    ],
    'dispatch-repository-owner-not-allowed': [
      'The repository owner is outside the configured intake scope.',
      'Restore the intended owner scope through Install or leave this assignment stopped.',
    ],
    'dispatch-repository-archived': [
      'The repository is archived.',
      'Leave this assignment stopped while archived. Resume its retained work only after the repository is reopened.',
    ],
    'dispatch-repository-disabled': [
      'GitHub has disabled the repository.',
      'Resolve the repository restriction with GitHub before retrying this assignment.',
    ],
    'dispatch-issue-identity-changed': [
      'The returned issue differs from the retained issue identity.',
      'Verify the issue number and provider ID against the retained assignment before continuing.',
    ],
    'dispatch-issue-type-changed': [
      'The returned item is not an issue.',
      'Verify the retained issue destination; do not apply an issue workflow to a different item type.',
    ],
    'dispatch-issue-closed': [
      'The assigned issue is closed.',
      'Keep completed work and leave automatic work stopped unless the issue is reopened and still assigned.',
    ],
    'dispatch-assignment-removed': [
      'This account is no longer assigned to the issue.',
      'Keep existing work. A new eligible assignment can resume intake; the old assignment grants no further work.',
    ],
    'dispatch-assignment-event-missing': [
      'GitHub returned no assignment event for the receiving account.',
      'Retry the bounded assignment-history read on a later check. Preserve existing requests and receipts; missing evidence does not justify another chat creation.',
    ],
    'dispatch-assignment-actor-type-changed': [
      'The assignment actor is not an eligible user.',
      'Check the actual assignment event and configured assigners before resuming the retained work.',
    ],
    'dispatch-assignment-actor-not-allowed': [
      'The assignment actor is outside the configured assigners.',
      'Review the assigner policy or await an eligible assignment. Reconcile intentional policy changes through Install.',
    ],
    'dispatch-assignment-actor-changed': [
      'The retained assignment actor no longer matches GitHub.',
      'Inspect the exact assignment event and retained admission before resuming; preserve the existing work.',
    ],
    'dispatch-assignment-superseded': [
      'A newer assignment superseded this request.',
      'Reconcile the old native creation receipt; intake can consider the newer assignment once duplicate creation is ruled out. No reassignment or credential change is needed.',
    ],
    'feedback-source-identity-changed': [
      'The returned feedback is a different source item.',
      'Inspect the exact retained comment ID and destination. Do not publish its retained reply against another comment.',
    ],
    'feedback-source-author-changed': [
      'The feedback author differs from the admitted author.',
      'Verify the source author before replying. Preserve the private response; do not publish the old candidate.',
    ],
    'feedback-source-changed': [
      'The admitted feedback content changed.',
      'Re-read the current comment through feedback context and prepare a reply for its current revision. Preserve the earlier private response.',
    ],
    'feedback-source-no-longer-eligible': [
      'The source no longer qualifies for the configured feedback workflow.',
      'Inspect the current source and feedback policy before replying; preserve the private response and leave the old publication stopped.',
    ],
  };
  const reason = reasons[code];
  if (reason) return { summary: reason[0], next: reason[1] };
  const field =
    /^delivery-(repository|issue|session|thread|worktree|branch|base|account|policy)-changed$/.exec(
      code,
    )?.[1];
  if (field)
    return {
      summary: `The delivery ${field} differs from the retained PR operation.`,
      next: `Inspect the current and retained ${field}. Restore the intended ${field} or explicitly reconcile its change before resuming the same delivery. Preserve the existing PR, checkout and receipts; do not create a replacement PR.`,
    };
  if (/(?:operation-failed|provider-failed|github-unknown)$/.test(code))
    return {
      summary: 'The operation failed without enough evidence to classify the cause.',
      next: 'Inspect this operation and its bounded diagnostic, then reconcile any retained native or provider receipt before retrying. No credential failure was established; preserve successful work and do not repeat an uncertain write.',
    };
}
