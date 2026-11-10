import assert from 'node:assert/strict';
import workflowStatus from '../agent/workflow-status.ts';

describe('agent/workflow-status', () => {
  it('should use native evidence for current conversation activity', () => {
    const record = { threadId: 'chat' };
    assert.equal(workflowStatus(record), 'native-unobserved');
    assert.equal(workflowStatus({ ...record, nativeInactive: true }), 'idle');
    assert.equal(workflowStatus({ ...record, nativeInactive: false }), 'active');
  });
  it('should keep published effects separate from conversation completion', () => {
    const record = {
      nativeInactive: false,
      delivery: { reconciled: true, pullRequest: { pullRequestNumber: 7 } },
    };
    assert.equal(workflowStatus(record), 'active');
    assert.equal(workflowStatus({ ...record, nativeInactive: true }), 'idle');
  });
  it('should report resource retirement and replacement independently', () => {
    assert.equal(workflowStatus({ retirement: {} }), 'retirement-pending');
    assert.equal(workflowStatus({ supersededBy: 'next' }), 'superseded');
    assert.equal(workflowStatus({ request: {} }), 'creating');
  });
});
