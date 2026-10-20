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
    'dispatch-capacity-observation-required': [
      'The historical creation has no native inactivity observation.',
      'The next owning intake run will inspect native receipts. Its action:reconcile can also observe this retired record. Preserve the request; do not create another chat for this issue.',
    ],
    'dispatch-capacity-creation-unresolved': [
      'No native child or proof of non-submission was found.',
      'Inspect the original intake preparation turn and its create_thread receipt. The owning intake can retry action:reconcile with this id after native history is readable. Missing history cannot establish that creation never happened.',
    ],
    'dispatch-capacity-native-missing': [
      'The retained native chat is unavailable.',
      'Restore access to the retained chat or inspect its archived native history and creation receipt, then retry reconciliation. A missing worktree or missing chat alone does not prove inactivity.',
    ],
    'dispatch-capacity-native-active': [
      'The historical native chat is still active.',
      'This chat consumes a live slot. Let it finish or stop it through native controls when authorized; intake must verify its terminal state before releasing it.',
    ],
    'dispatch-capacity-native-not-ended': [
      'The matching native chat has no verified ended and inactive turn.',
      'Let the native turn finish, or stop it through the native chat controls when authorized. Intake will verify terminal evidence; do not discard its request or force a slot release.',
    ],
    'dispatch-capacity-observation-unavailable': [
      'Native capacity observation could not complete.',
      'Retry native observation of the retained chat or preparation turn when host history is available. Preserve the reservation and source receipts.',
    ],
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
      'Review the repository owner scope in agent.yaml, then retry the retained assignment. Live policy changes apply without Install.',
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
      'Review the assigner policy in agent.yaml or await an eligible assignment, then retry. Live policy changes apply without Install.',
    ],
    'assignment-removal-unapproved': [
      'GitHub assignment is missing; its removal actor is not approved. Prior admitted work remains eligible in its existing mode and stage unless another lifecycle or native stop applies.',
      'Verified reassignment or a relevant live issue-assignment.allowed change can resolve removal authority. No automatic reassignment occurs.',
    ],
    'assignment-removal-evidence-unavailable': [
      'GitHub assignment is missing; removal authority could not be verified. Prior admitted work remains eligible in its existing mode and stage unless another lifecycle or native stop applies.',
      'Recover provider evidence or verify reassignment. Chat, worktree and prior stage are preserved; no automatic reassignment occurs.',
    ],
    'assignment-removal-evidence-conflicting': [
      'GitHub assignment is missing, but assignment events conflict with membership or retained admission. Prior admitted work remains eligible in its existing mode and stage unless another lifecycle or native stop applies.',
      'Reconcile provider evidence or verify reassignment before authorizing retirement. No automatic reassignment occurs.',
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
