import assert from 'node:assert/strict';
import workflowStatus from '../agent/workflow-status.ts';

describe('agent/workflow-status', () => {
  it('should distinguish obsolete intent without discarding its native reservation', () => {
    const record = { phase: 'blocked', blocker: 'dispatch-assignment-superseded' };
    assert.equal(workflowStatus(record), 'obsolete');
    assert.equal(record.phase, 'blocked');
    assert.equal(workflowStatus({ phase: 'creating', retired: { at: 1 } }), 'obsolete');
  });
  it('should distinguish retries and waiting from explicit stops', () => {
    assert.equal(workflowStatus({ phase: 'waiting' }), 'waiting');
    assert.equal(workflowStatus({ phase: 'waiting', retry: { attempts: 1 } }), 'retrying');
    assert.equal(workflowStatus({ phase: 'blocked', retry: { attempts: 1 } }), 'blocked');
    assert.equal(
      workflowStatus({
        phase: 'complete',
        continuation: { phase: 'running', code: 'github-rate-limited', retry: {} },
      }),
      'retrying',
    );
  });
  it('should preserve published work when delivery remains incomplete in either runtime', () => {
    const delivery = { pullRequest: { pullRequestNumber: 7 }, reconciled: true };
    assert.equal(workflowStatus({ phase: 'complete', delivery }), 'partially-delivered');
    assert.equal(workflowStatus({ phase: 'complete', work: { delivery } }), 'partially-delivered');
    const completed = {
      ...delivery,
      attached: true,
      announcement: { receipt: { nodeId: 'comment' } },
    };
    assert.equal(workflowStatus({ phase: 'complete', delivery: completed }), 'complete');
    assert.equal(
      workflowStatus({ phase: 'complete', delivery: { ...completed, attached: false } }),
      'partially-delivered',
    );
  });
});
