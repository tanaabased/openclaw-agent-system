import assert from 'node:assert/strict';
import workflowStatus from '../agent/workflow-status.ts';

describe('agent/workflow-status', () => {
  it('should report decision assessment and legacy handoff without claiming cancelled work', () => {
    assert.equal(workflowStatus({ phase: 'complete', autoDecision: {} }), 'assessing');
    assert.equal(
      workflowStatus({ phase: 'complete', decisionTurn: { status: 'consumed' } }),
      'assessing',
    );
    assert.equal(
      workflowStatus({
        phase: 'complete',
        autoDecision: { code: 'continuation-native-send-failed' },
      }),
      'blocked',
    );
    assert.equal(
      workflowStatus({ phase: 'complete', handoff: {}, continuation: { phase: 'cancelled' } }),
      'running',
    );
  });
  it('should distinguish cancellation policy holds and unfinished delivery from authorization failures', () => {
    assert.equal(
      workflowStatus({ phase: 'complete', continuation: { phase: 'cancelled' } }),
      'cancelled',
    );
    assert.equal(
      workflowStatus({
        phase: 'complete',
        continuation: { phase: 'waiting', policyHeld: 'implementation-disabled' },
      }),
      'policy-held',
    );
    assert.equal(
      workflowStatus({ phase: 'complete', work: { code: 'implementation-result-missing' } }),
      'result-missing',
    );
    assert.equal(
      workflowStatus({
        phase: 'complete',
        work: { code: 'implementation-delivery-incomplete', result: { outcome: 'done' } },
      }),
      'delivery',
    );
  });
  it('should report feedback progress without reviving the original continuation status', () => {
    const event = {
      phase: 'running',
      work: { head: 'new', result: { outcome: 'clarification-needed' } },
    };
    const record = {
      phase: 'complete',
      continuation: { phase: 'waiting' },
      feedback: { events: [event] },
    };
    assert.equal(workflowStatus(record), 'clarification-needed');
    event.work.result.outcome = 'done';
    assert.equal(workflowStatus(record), 'delivery');
    const delivery = {
      pullRequest: { pullRequestNumber: 7 },
      reconciled: true,
      pushedHead: 'old',
      announcement: { receipt: {} },
    };
    assert.equal(workflowStatus({ ...record, delivery }), 'delivery');
    delivery.pushedHead = 'new';
    assert.equal(workflowStatus({ ...record, delivery }), 'complete');
    assert.equal(workflowStatus({ ...record, work: { delivery } }), 'complete');
    event.work.result.outcome = 'blocked';
    assert.equal(workflowStatus({ ...record, delivery }), 'blocked');
  });
  it('should report the current implementation stage instead of the completed assessment', () => {
    const assessment = { phase: 'complete', result: { outcome: 'plan-ready' } };
    assert.equal(workflowStatus(assessment), 'plan-ready');
    for (const phase of ['waiting', 'prepared', 'running', 'delivery', 'complete'])
      assert.equal(workflowStatus({ ...assessment, continuation: { phase } }), phase);
    for (const [status, expected] of [
      ['attempted', 'uncertain'],
      ['accepted', 'prepared'],
      ['consumed', 'running'],
      ['completed', 'running'],
    ])
      assert.equal(
        workflowStatus({ ...assessment, work: { turn: { status: status! } } }),
        expected,
      );
    assert.equal(workflowStatus({ ...assessment, work: { implementation: {} } }), 'running');
    assert.equal(
      workflowStatus({ ...assessment, work: { result: { outcome: 'done' } } }),
      'delivery',
    );
    assert.deepEqual(assessment, { phase: 'complete', result: { outcome: 'plan-ready' } });
  });
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
  it('should retain clarification separately from native failure in both runtimes', () => {
    assert.equal(
      workflowStatus({ phase: 'complete', continuation: { phase: 'clarification-needed' } }),
      'clarification-needed',
    );
    const work = { result: { outcome: 'clarification-needed' } };
    assert.equal(workflowStatus({ phase: 'complete', work }), 'clarification-needed');
    assert.equal(
      workflowStatus({
        phase: 'complete',
        work: { ...work, caller: { runId: 'answer' }, clarificationInput: { runId: 'question' } },
      }),
      'running',
    );
    assert.equal(
      workflowStatus({ phase: 'complete', work: { ...work, code: 'dispatch-turn-cancelled' } }),
      'blocked',
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
