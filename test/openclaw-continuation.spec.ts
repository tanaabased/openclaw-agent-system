import assert from 'node:assert/strict';

import advanceOpenClawWork, { openClawWorkSlot } from '../agent/openclaw-continuation.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';

function delivered() {
  return {
    id: 'issue',
    phase: 'complete',
    request: { key: 'chat', agentId: 'agent' },
    sessionCreation: { verified: true },
    assessmentTurn: { status: 'completed' },
    progression: { stage: 'implementation', via: 'work' },
    result: { outcome: 'plan-ready' },
    work: {
      result: { outcome: 'done', summary: 'Done.', fullResult: 'Checked.' },
      turn: { status: 'completed', runId: 'implementation', message: 'Work.' },
      delivery: {
        pullRequest: { pullRequestNumber: 7 },
        reconciled: true,
      },
    },
  } as OpenClawDispatchRecord;
}

describe('agent/openclaw-continuation', () => {
  it('should leave delivered work idle regardless of missing card or announcement outcomes', async () => {
    const record = delivered();
    const before = structuredClone(record);
    const result = await advanceOpenClawWork({
      record,
      mode: 'work',
      now: 1,
      config: {},
      request: async () => {
        throw new Error('delivered work must not send or inspect a native turn');
      },
      save: async () => {
        throw new Error('delivered work must not create another attempt');
      },
      assertCurrent: async () => {},
    });
    assert.equal(result.status, 'implementation-idle');
    assert.deepEqual(record, before);
  });

  it('should still reconcile an already submitted native turn without preparing another', () => {
    const record = delivered();
    record.work!.deliveryTurn = { status: 'accepted', runId: 'delivery', message: 'Deliver.' };
    assert.equal(openClawWorkSlot(record, 'work'), 'deliveryTurn');
    record.work!.deliveryTurn.status = 'completed';
    assert.equal(openClawWorkSlot(record, 'work'), undefined);
  });

  it('should recover unfinished implementation and publication before delivery', () => {
    const record = delivered();
    record.work!.delivery!.reconciled = false;
    assert.equal(openClawWorkSlot(record, 'work'), 'deliveryTurn');
    delete record.work!.result;
    assert.equal(openClawWorkSlot(record, 'work'), 'turn');
  });

  it('should not let an earlier announcement failure hold a new publication', () => {
    const record = delivered();
    record.work!.delivery!.reconciled = false;
    record.work!.delivery!.announcement = { code: 'delivery-announcement-denied' } as NonNullable<
      NonNullable<typeof record.work>['delivery']
    >['announcement'];
    assert.equal(openClawWorkSlot(record, 'work'), 'deliveryTurn');
  });

  it('should preserve native cancellation as a stop', () => {
    const record = delivered();
    record.work!.code = 'dispatch-turn-cancelled';
    assert.equal(openClawWorkSlot(record, 'work'), undefined);
  });
});
