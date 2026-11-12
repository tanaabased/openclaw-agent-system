import assert from 'node:assert/strict';

import advanceOpenClawWork, {
  openClawWorkSlot,
} from '../agent/tasks/implementation/openclaw-continuation.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';

function delivered() {
  return {
    id: 'issue',

    request: { key: 'chat', agentId: 'agent' },
    sessionCreation: { verified: true },
    progression: { stage: 'implementation', via: 'work' },
    delivery: {
      pullRequest: { pullRequestNumber: 7 },
      reconciled: true,
    },
    work: {},
    nativeTurns: [{ role: 'assessment', turn: { status: 'completed' } }],
  } as OpenClawDispatchRecord;
}

describe('agent/openclaw-continuation', () => {
  it('should leave delivered work idle regardless of missing card or announcement outcomes', async () => {
    const record = delivered();
    record.handoff = { at: 1, by: 'chat', turnId: 'old' };
    const before = structuredClone(record);
    const result = await advanceOpenClawWork({
      record,
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

  it('should reconcile only the already submitted initial turn', () => {
    const record = delivered();
    const turn = { status: 'accepted' as const, runId: 'initial', message: 'Assess.' };
    record.nativeTurns!.push({ role: 'assessment', turn });
    assert.equal(openClawWorkSlot(record), 'native');
    record.nativeTurns!.at(-1)!.turn.status = 'completed';
    assert.equal(openClawWorkSlot(record), undefined);
  });

  it('should not turn missing results or publication into a new request', () => {
    const record = delivered();
    record.delivery!.reconciled = false;
    assert.equal(openClawWorkSlot(record), undefined);
  });

  it('should not let an announcement failure hold unfinished initial publication', () => {
    const record = delivered();
    record.delivery!.reconciled = false;
    record.announcement = { code: 'delivery-announcement-denied' } as NonNullable<
      typeof record.announcement
    >;
    assert.equal(openClawWorkSlot(record), undefined);
  });

  it('should leave inactive native turns stopped', () => {
    const record = delivered();
    record.nativeTurns!.push({
      role: 'assessment',
      turn: { status: 'accepted', runId: 'stopped', message: 'Assess.', inactive: true },
    });
    assert.equal(openClawWorkSlot(record), undefined);
  });
});
