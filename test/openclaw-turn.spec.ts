import assert from 'node:assert/strict';

import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import type { OpenClawTurn } from '../agent/openclaw-turn-state.ts';
import { consumedInputEvent, reconcileOpenClawTurn } from '../agent/openclaw-turn.ts';

describe('agent/openclaw-turn', () => {
  for (const conflict of ['selection', 'input', 'body', 'key'] as const)
    it(`should refuse execution-hint repair with a conflicting ${conflict}`, () => {
      const turn: OpenClawTurn = {
        runId: 'delivery',
        message: 'original feedback',
        status: 'consumed',
        consumedByEventId: 'input',
        executionRunId: 'later-responder',
      };
      const selection = {
        runId: conflict === 'selection' ? 'another-responder' : 'later-responder',
        inputEventId: 'input',
      };
      const message = {
        role: 'user',
        content: conflict === 'body' ? 'different feedback' : turn.message,
        __openclaw: {
          id: conflict === 'input' ? 'different-input' : 'input',
          runId: 'delivery',
          idempotencyKey: conflict === 'key' ? 'another-delivery:user' : 'delivery:user',
        },
      };
      assert.throws(
        () => consumedInputEvent([message], turn, true, selection),
        /dispatch-turn-run-mismatch|dispatch-turn-input-mismatch/,
      );
      assert.equal(turn.executionRunId, 'later-responder');
    });
  it('should not replace a retained execution from an unrelated native observation', () => {
    const turn: OpenClawTurn = {
      runId: 'delivery',
      message: 'feedback',
      status: 'consumed',
      consumedByEventId: 'input',
      executionRunId: 'original-execution',
    };
    assert.throws(
      () =>
        consumedInputEvent(
          [
            {
              role: 'user',
              content: 'feedback',
              __openclaw: {
                id: 'input',
                idempotencyKey: 'delivery:user',
                runId: 'different-execution',
              },
            },
          ],
          turn,
          true,
        ),
      /dispatch-turn-run-mismatch/,
    );
    assert.equal(turn.executionRunId, 'original-execution');
  });
  it('should settle a queued input through its native execution without resending it', async () => {
    const turn: OpenClawTurn = { runId: 'delivery', message: 'queued comment', status: 'accepted' };
    const waited: unknown[] = [];
    await reconcileOpenClawTurn({
      turn,
      allowExecutionRunId: true,
      sessionKey: 'chat',
      sessionId: 'session',
      save: async () => {},
      request: async (method, params) => {
        if (method === 'chat.history')
          return {
            sessionId: 'session',
            inputReceipts: [{ runId: 'delivery', state: 'consumed', consumedByEventId: 'input' }],
            sessionInfo: { hasActiveRun: false },
            pendingInputs: { total: 0 },
            messages: [
              {
                role: 'user',
                content: 'queued comment',
                __openclaw: {
                  id: 'input',
                  runId: 'execution',
                  idempotencyKey: 'delivery:user',
                },
              },
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'reply' }],
                stopReason: 'stop',
                __openclaw: {
                  id: 'reply',
                  runId: 'execution',
                  runTerminal: true,
                },
              },
            ],
          };
        assert.equal(method, 'agent.wait');
        waited.push(params.runId);
        return {
          runId: params.runId,
          status: 'ok',
          terminalReceipt: {
            runId: 'execution',
            sessionId: 'session',
            effective: { provider: 'test', model: 'model' },
          },
        };
      },
    });
    assert.deepEqual(waited, ['execution']);
    assert.equal(turn.runId, 'delivery');
    assert.equal(turn.executionRunId, 'execution');
    assert.equal(turn.status, 'completed');
    assert.equal(turn.consumedByEventId, 'input');
    assert.equal(turn.replyEventId, 'reply');
    assert.equal(turn.executionModel, 'test/model');
  });
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
