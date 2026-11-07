import assert from 'node:assert/strict';

import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { OpenClawTurn } from '../agent/openclaw-turn-state.ts';
import { reconcileOpenClawTurn } from '../agent/openclaw-turn.ts';

describe('agent/openclaw-turn', () => {
  for (const pending of [0, 1, undefined, -1, 'missing']) {
    it(`should refresh capacity from native history without another poll with ${pending} pending inputs`, async () => {
      const record: Pick<OpenClawDispatchRecord, 'nativeInactive'> = { nativeInactive: true };
      const turn: OpenClawTurn = {
        runId: 'turn',
        message: 'accepted',
        status: 'accepted',
        cancelled: true,
      };
      let reads = 0;
      await assert.rejects(
        reconcileOpenClawTurn({
          record,
          turn,
          sessionKey: 'chat',
          sessionId: 'session',
          save: async () => {},
          request: async (method) => {
            assert.equal(method, 'chat.history');
            reads++;
            return {
              sessionId: 'session',
              messages: [],
              inputReceipts: [],
              sessionInfo: { hasActiveRun: false },
              ...(pending === 'missing' ? {} : { pendingInputs: { total: pending } }),
            };
          },
        }),
        /dispatch-turn-cancelled/,
      );
      assert.equal(reads, 1);
      assert.equal(record.nativeInactive, pending === 0 ? true : pending === 1 ? false : undefined);
      assert.equal(turn.cancelled, true);
    });
  }
});
