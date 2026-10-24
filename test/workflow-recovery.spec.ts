import assert from 'node:assert/strict';
import workflowRecovery from '../agent/workflow-recovery.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import { intakeRemediation } from '../channels/github/intake/record-store.ts';

describe('agent/workflow-recovery', () => {
  it('should explain how to correct an incomplete assessment without replacing its saved result', () => {
    const recovery = workflowRecovery('assessment-result-incomplete')!;
    assert.match(recovery.summary, /not recorded/);
    assert.match(recovery.next, /fullAssessment.*resubmit/);
    assert.match(recovery.next, /previous saved result/);
  });
  it('should explain how to recover from a malformed dispatch receipt id', () => {
    const recovery = workflowRecovery('dispatch-receipt-id-invalid')!;
    assert.match(recovery.summary, /not looked up/);
    assert.match(recovery.next, /exact receipt ID from verified workflow context/);
    assert.match(recovery.next, /Do not guess/);
  });
  it('should explain pre-reset restoration without authorizing replay or deletion', () => {
    const recovery = workflowRecovery('notification-state-reset-required')!;
    assert.match(recovery.summary, /no workflow was resumed/);
    assert.match(recovery.next, /Preserve the original file/);
    assert.match(recovery.next, /explicit notification reset/);
  });
  it('should direct assignment recovery at the actual failed predicate', () => {
    assert.match(workflowRecovery('dispatch-issue-closed')!.next, /reopened/);
    assert.match(workflowRecovery('dispatch-assignment-removed')!.next, /new eligible assignment/);
    assert.match(workflowRecovery('dispatch-assignment-event-missing')!.next, /history/);
    assert.match(workflowRecovery('dispatch-assignment-superseded')!.next, /newer assignment/);
  });
  it('should reconcile the specific delivery field and preserve the existing pr', () => {
    for (const field of [
      'repository',
      'issue',
      'session',
      'thread',
      'worktree',
      'branch',
      'base',
      'account',
      'policy',
    ]) {
      const recovery = workflowRecovery(`delivery-${field}-changed`)!;
      assert.ok(recovery.summary.includes(field));
      assert.match(recovery.next, /same delivery/);
      assert.match(recovery.next, /existing PR/);
    }
  });
  it('should recommend credential repair only with authentication evidence', () => {
    const unknown = workflowRecovery(
      'workflow-operation-failed',
      providerDiagnostic('github', 'api-request', 'unknown'),
    )!;
    assert.match(unknown.next, /do not change credentials/);
    const auth = workflowRecovery(
      'provider-failed',
      providerDiagnostic('github', 'api-request', 'authentication'),
    )!;
    assert.match(auth.next, /Check the credential/);
    assert.match(intakeRemediation('intake-github-permission'), /granted repository permissions/);
    assert.doesNotMatch(intakeRemediation('intake-github-permission'), /native approval/);
    assert.match(intakeRemediation('intake-github-unknown'), /do not change credentials/);
  });
});
