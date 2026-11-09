import assert from 'node:assert/strict';
import workflowStatus from '../agent/workflow-status.ts';

describe('agent/workflow-status', () => {
  it('should use native evidence without deriving progress from retained controller history', () => {
    for (const phase of ['waiting', 'running', 'complete', 'blocked', 'cancelled']) {
      const record = {
        phase: 'complete',
        threadId: 'chat',
        continuation: { phase },
        feedback: { events: [{ phase: 'blocked', work: { result: { outcome: 'blocked' } } }] },
      };
      assert.equal(workflowStatus(record), 'native-unobserved');
      assert.equal(workflowStatus({ ...record, nativeInactive: true }), 'idle');
      assert.equal(workflowStatus({ ...record, nativeInactive: false }), 'active');
    }
  });
  it('should keep published effects separate from conversation completion', () => {
    const record = {
      phase: 'complete',
      nativeInactive: false,
      delivery: { reconciled: true, pullRequest: { pullRequestNumber: 7 } },
    };
    assert.equal(workflowStatus(record), 'active');
    assert.equal(workflowStatus({ ...record, nativeInactive: true }), 'idle');
  });
  it('should report resource retirement and replacement independently', () => {
    assert.equal(workflowStatus({ phase: 'complete', retirement: {} }), 'retirement-pending');
    assert.equal(workflowStatus({ phase: 'complete', supersededBy: 'next' }), 'superseded');
    assert.equal(workflowStatus({ phase: 'creating' }), 'creating');
  });
});
