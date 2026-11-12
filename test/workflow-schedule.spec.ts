import assert from 'node:assert/strict';
import {
  requireWorkflowSchedule,
  type WorkflowScheduleAuthority,
} from '../agent/tasks/workflow-schedule.ts';
describe('agent/workflow-schedule', () => {
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
    requireWorkflowSchedule(
      fresh,
      { ...current, policyDigest: 'changed', definitionDigest: 'changed' },
      'publication',
    );
    for (const key of ['workflow', 'automationId', 'sourceThreadId'])
      assert.throws(
        () => requireWorkflowSchedule(fresh, { ...current, [key]: 'changed' }, 'publication'),
        /workflow-schedule-reconciliation-required/,
      );
  });
});
