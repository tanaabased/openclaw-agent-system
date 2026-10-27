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
    'assessment-result-incomplete': [
      'The new assessment is missing its complete source; the result was not recorded.',
      'Include the complete assessment, evidence, plan or questions in `fullAssessment` and resubmit the result in this chat. Keep the previous saved result; do not substitute a summary for the source.',
    ],
    'dispatch-receipt-id-invalid': [
      'The supplied receipt ID is malformed, so it was not looked up or used to change workflow state.',
      'Copy the exact receipt ID from verified workflow context and retry. Do not guess, correct, reset, or recreate the workflow.',
    ],
    'launch-open-issue-required': [
      'Manual launch requires an accessible open GitHub issue.',
      'Choose an open issue, not a pull request or comment. Preserve any existing preparation; changing the target is not recovery of that attempt.',
    ],
    'launch-owner-inactive': [
      'This issue already has an inactive managed owner.',
      'Preserve that owner. Use explicit recovery for replacement, or request a separate task through Task Launch from an operator chat. Do not revive the inactive chat or delete its record.',
    ],
    'launch-owner-ambiguous': [
      'More than one retained owner matches this issue.',
      'Supply the exact task id to select intentional additional work, or reconcile unexpected competing owners. No new chat or checkout was authorized.',
    ],
    'launch-preparation-owner-required': [
      'The issue is already being prepared by another managed source.',
      'Return to the original launching or intake conversation to reconcile the same attempt. Do not repeat repository or chat creation here.',
    ],
    'launch-selections-conflict': [
      'Explicit launch choices differ from the retained preparation.',
      'Retry the original receipt with its saved choices. Use the existing stage owner for subsequent policy or direction changes, not a new launch.',
    ],
    'launch-assignment-actor-recipient-unavailable': [
      'An explicit delivery recipient requires an assignment actor, but this work was requested manually.',
      'Replace that explicit recipient requirement with a named recipient or omit it, then retry the same launch. Do not invent an assigner or assign the issue as a workaround.',
    ],
    'launch-receipt-mismatch': [
      'The launch receipt does not match this issue owner.',
      'Use the original target and receipt together; inspect existing work before requesting another launch.',
    ],
    'codex-branch-owner-required': [
      'This assignment has no verified ownership record for its current branch.',
      'Preserve all files and commits. In standalone Codex, an operator may explicitly select a verified existing PR through delivery bind. Otherwise resume the retained starting checkout through implementation context or reconcile the original delivery receipt. A branch name or historical comment alone cannot establish ownership.',
    ],
    'dispatch-task-superseded': [
      'This preserved task was replaced and cannot continue managed work.',
      'Use the successorId from the retained recovery result with Task Launch. Read the predecessor assessment with present if needed; do not resume its publication or delete its evidence.',
    ],
    'dispatch-recovery-chat-active-or-unverified': [
      'Replacement could not verify an idle predecessor with an ended completed native turn.',
      'Let the exact predecessor finish and restore native activity readback before previewing again. Idle, missing or interrupted history alone is insufficient; no successor was reserved.',
    ],
    'delivery-binding-publication-pending': [
      'Earlier publication has an uncertain outcome, so its destination was not changed.',
      'Resume the original delivery or announcement through its retained receipts before selecting a different PR. Do not repeat uncertain writes or discard their tracking.',
    ],
    'launch-pr-runtime-unsupported': [
      'Existing-PR startup is currently available only in standalone Codex.',
      'Use standalone Codex Task Launch for explicit PR selection. OpenClaw manual fresh launch remains available without pullRequest; do not silently omit a requested PR.',
    ],
    'codex-branch-owner-mismatch': [
      'The current branch does not belong to this assignment attempt.',
      'Preserve local work and switch back to this attempt’s retained branch before resuming. Do not reset or adopt a retired attempt’s branch.',
    ],
    'codex-branch-preparation-required': [
      'This attempt’s branch preparation has not completed.',
      'Resume implementation context in the retained chat to reconcile the saved Git operation before delivery. Do not create another branch or pull request.',
    ],
    'codex-branch-start-changed': [
      'The checkout changed before this attempt’s branch preparation completed.',
      'Preserve the changed files and commits and inspect the retained preparation before resuming. Do not reset the checkout or move another attempt’s commits onto this branch.',
    ],
    'codex-branch-ref-occupied': [
      'The selected branch already exists without matching preparation evidence.',
      'Preserve the branch and reconcile its owner before retrying in the same chat. Do not force-create, reset, or rename it to bypass the conflict.',
    ],
    'git-worktree-branch-exists': [
      'This attempt already has a branch, but its owned checkout is absent.',
      'Preserve the branch and reconcile the retained preparation before retrying. Do not reset it or create another attempt to bypass an uncertain Git effect.',
    ],
    'git-worktree-owner-mismatch': [
      'The issue checkout belongs to a different branch or assignment attempt.',
      'Inspect the retained owner and finish its verified retirement before retrying this assignment. Preserve existing work; do not adopt or reset the checkout.',
    ],
    'git-worktree-path-occupied': [
      'The issue checkout path is occupied without matching managed Git ownership.',
      'Inspect and preserve the existing directory, reconcile its ownership, then retry this assignment through the operator retry action.',
    ],
    'notification-state-reset-required': [
      'Restored notification tracking predates the required reset; no workflow was resumed.',
      'Preserve the original file. Restore backups into staging and use the compatible reset-capable release to complete an explicit notification reset before upgrading. Do not delete journals or recreate assignments to bypass this boundary.',
    ],
    'instance-install-required': [
      'This installation has no saved identity.',
      'Run Install to create its persistent UUID and readable name before claiming assignments.',
    ],
    'claim-disabled-pending': [
      'This assignment has a retained claim from the pilot, and claim election is disabled.',
      'Inspect its original owner and native work before resolving this assignment. Do not delete claim receipts or start replacement work.',
    ],
    'claim-winner-missing': [
      'The retained winning claim is missing or its metadata was edited.',
      'Inspect the original owner and native work before restoring its claim. Do not create replacement work or take ownership by deleting state.',
    ],
    'claim-winner-changed': [
      'The visible winner differs from the retained owner.',
      'Reconcile the original winning comment and native work before resuming; automatic takeover is disabled.',
    ],
    'claim-instance-rotated': [
      'This assignment belongs to the installation identity that was rotated.',
      'Keep its retained native work with the original owner. Rotation does not transfer existing assignments; this installation can claim new assignments.',
    ],
    'claim-publication-unconfirmed': [
      'The claim publication has no confirmed provider receipt.',
      'Reconcile the original comment when GitHub is readable; do not post another claim for this attempt.',
    ],
    'dispatch-capacity-observation-required': [
      'The historical creation has no native inactivity observation.',
      'The next owning intake run will inspect native receipts. Its `action:reconcile` can also observe this retired record. Preserve the request; do not create another chat for this issue.',
    ],
    'dispatch-capacity-creation-unresolved': [
      'No native child or proof of non-submission was found.',
      'Inspect the original intake preparation turn and its `create_thread` receipt. The owning intake can retry `action:reconcile` with this id after native history is readable. Missing history cannot establish that creation never happened.',
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
      'Review the repository owner scope in `agent.yaml`, then retry the retained assignment. Live policy changes apply without Install.',
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
      'Review the assigner policy in `agent.yaml` or await an eligible assignment, then retry. Live policy changes apply without Install.',
    ],
    'assignment-removal-unapproved': [
      'GitHub assignment is missing; its removal actor is not approved. Prior admitted work remains eligible in its existing mode and stage unless another lifecycle or native stop applies.',
      'Verified reassignment or a relevant live `issue-assignment.allowed` change can resolve removal authority. No automatic reassignment occurs.',
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
  if (
    ['delivery-binding-stale', 'launch-pr-binding-changed', 'launch-pr-head-changed'].includes(code)
  )
    return {
      summary: 'The selected PR or work changed after its preview; the selection was not applied.',
      next: 'Refresh the same launch or binding preview with its exact target and receipt, inspect the current head and destination, then apply its new digest within the operator request. Preserve local work and any existing creation request; never replay an uncertain creation.',
    };
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
