import assert from 'node:assert/strict';

import { automationHash } from '../agent/automation-hash.ts';
import {
  publicationDisposition,
  requireWorkflowSchedule,
  validateWorkflowResult,
  type WorkflowBinding,
  type WorkflowScheduleAuthority,
} from '../agent/workflow-result.ts';

describe('agent/workflow-result', () => {
  const binding: WorkflowBinding = {
    admissionId: 'admitted',
    workflow: 'review-request',
    repositoryId: 'repo',
    subjectId: 'pr',
    threadId: 'review-chat',
    worktree: '/review-checkout',
    routingDigest: 'f'.repeat(64),
    turnId: 'turn-1',
    dispatchDigest: 'a'.repeat(64),
    policyDigest: 'b'.repeat(64),
    selectionDigest: 'c'.repeat(64),
    evidenceDigest: 'd'.repeat(64),
  };
  const result = {
    version: 1,
    stage: 'review',
    resultContract: 'review-result/v1',
    binding,
    result: {
      outcome: 'done',
      summary: 'First pass is sufficient under the selected skill.',
      publicationCandidates: [],
    },
  };
  const expected = { binding, stage: 'review' as const, authorized: true };
  it('should accept first-pass done and skill-owned wait or blocker without substantive scheduler rules', () => {
    for (const outcome of ['done', 'wait', 'continue', 'blocked']) {
      const value = { ...result, result: { ...result.result, outcome } };
      assert.deepEqual(validateWorkflowResult(value, expected), value);
    }
  });
  it('should reject missing or invalid results and model-supplied authority or publication receipts', () => {
    for (const value of [
      undefined,
      'done',
      { ...result, result: undefined },
      { ...result, authorized: true },
      { ...result, resultContract: 'assessment-result/v1' },
      { ...result, result: { ...result.result, publicationReceipt: 'published' } },
    ])
      assert.throws(() => validateWorkflowResult(value, expected), /workflow-result-invalid/);
  });
  it('should bind each result to current authority, selected skill, admitted owner, native dispatch and processed evidence', () => {
    assert.throws(
      () => validateWorkflowResult(result, { ...expected, authorized: false }),
      /workflow-authority-lost/,
    );
    for (const key of Object.keys(binding) as Array<keyof WorkflowBinding>) {
      const changed = {
        ...binding,
        [key]:
          key === 'workflow'
            ? 'issue-assignment'
            : key.endsWith('Digest')
              ? 'e'.repeat(64)
              : 'other',
      } as WorkflowBinding;
      assert.throws(
        () => validateWorkflowResult(result, { ...expected, binding: changed }),
        /workflow-result-stale/,
      );
    }
    assert.throws(
      () => validateWorkflowResult(result, { ...expected, stage: 'implementation' }),
      /workflow-stage-mismatch/,
    );
    const wrongOwner = { ...binding, workflow: 'issue-assignment' as const };
    assert.throws(
      () =>
        validateWorkflowResult(
          { ...result, binding: wrongOwner },
          { ...expected, binding: wrongOwner },
        ),
      /workflow-stage-mismatch/,
    );
  });
  it('should reject assessment-only or stale schedule authority for implementation and publication', () => {
    const current = {
      workflow: 'issue-assignment' as const,
      automationId: 'workflow',
      sourceThreadId: 'intake',
      policyDigest: 'policy-1',
      definitionDigest: 'saved-1',
    };
    const saved: WorkflowScheduleAuthority = {
      ...current,
      version: 1,
      capabilities: ['assessment'],
    };
    requireWorkflowSchedule(saved, current, 'assessment');
    for (const capability of ['implementation', 'review', 'publication'] as const)
      assert.throws(
        () => requireWorkflowSchedule(saved, current, capability),
        /workflow-schedule-reconciliation-required/,
      );
    assert.throws(
      () => requireWorkflowSchedule(undefined, current, 'assessment'),
      /workflow-schedule-reconciliation-required/,
    );
    const fresh: WorkflowScheduleAuthority = {
      ...saved,
      capabilities: ['implementation', 'publication'],
    };
    requireWorkflowSchedule(fresh, current, 'publication');
    for (const key of Object.keys(current))
      assert.throws(
        () => requireWorkflowSchedule(fresh, { ...current, [key]: 'changed' }, 'publication'),
        /workflow-schedule-reconciliation-required/,
      );
  });
  it('should reconcile uncertain publication and require a provider receipt bound to the candidate', () => {
    assert.equal(publicationDisposition(undefined, 'candidate', binding), 'prepare');
    const receipt = {
      candidateId: 'candidate',
      bindingDigest: automationHash(binding),
      status: 'uncertain' as const,
    };
    assert.equal(publicationDisposition(receipt, 'candidate', binding), 'reconcile');
    assert.throws(
      () => publicationDisposition({ ...receipt, status: 'published' }, 'candidate', binding),
      /workflow-publication-receipt-invalid/,
    );
    assert.equal(
      publicationDisposition(
        {
          ...receipt,
          status: 'published',
          providerId: 'review-1',
          url: 'https://github.com/owner/repo/pull/1#review-1',
        },
        'candidate',
        binding,
      ),
      'published',
    );
    assert.throws(
      () => publicationDisposition(receipt, 'other', binding),
      /workflow-publication-binding-mismatch/,
    );
    assert.throws(
      () =>
        publicationDisposition(receipt, 'candidate', {
          ...binding,
          evidenceDigest: 'f'.repeat(64),
        }),
      /workflow-publication-binding-mismatch/,
    );
  });
});
