import assert from 'node:assert/strict';

import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import { resolveOpenClawTurnFeedback } from '../agent/tasks/feedback/openclaw-feedback-input.ts';

describe('agent/openclaw-turn-feedback', () => {
  const caller = { sessionKey: 'chat', sessionId: 'session', runId: 'execution' };
  const record = {
    threadId: 'chat',
    sessionCreation: { sessionId: 'session', verified: true },
    feedback: {
      events: [
        { id: 'first', turn: { runId: 'send-one', message: 'first comment' } },
        { id: 'second', turn: { runId: 'send-two', message: 'second comment' } },
      ],
    },
  } as OpenClawDispatchRecord;
  const message = {
    role: 'user',
    content: 'first comment',
    __openclaw: { id: 'input', runId: 'execution', idempotencyKey: 'send-one:user' },
  };

  it('should resolve a queued source from native execution without selecting the latest comment or saving state', async () => {
    const before = structuredClone(record);
    const selected = await resolveOpenClawTurnFeedback(
      record,
      caller,
      async () => ({ sessionId: 'session', messages: [message] }),
      {},
      'input',
    );
    assert.equal(selected?.event.id, 'first');
    assert.equal(selected?.inputId, 'input');
    assert.deepEqual(record, before);
  });

  it('should preserve exact input binding when native metadata omits the execution run', async () => {
    const input = structuredClone(message);
    delete (input.__openclaw as { runId?: string }).runId;
    const read = async () => ({ sessionId: 'session', messages: [input] });
    assert.equal(
      (await resolveOpenClawTurnFeedback(record, { ...caller, inputId: 'input' }, read, {}))?.event
        .id,
      'first',
    );
    assert.equal(await resolveOpenClawTurnFeedback(record, caller, read, {}), undefined);
  });

  it('should refuse mismatched incarnation and incomplete history instead of guessing a source', async () => {
    await assert.rejects(
      resolveOpenClawTurnFeedback(record, { ...caller, sessionId: 'other' }, async () => ({}), {}),
      /reply-managed-context-invalid/,
    );
    await assert.rejects(
      resolveOpenClawTurnFeedback(
        record,
        caller,
        async () => ({ sessionId: 'session', messages: [], hasMore: true }),
        {},
      ),
      /workflow-evidence-incomplete/,
    );
    assert.equal(
      await resolveOpenClawTurnFeedback(
        record,
        caller,
        async () => ({ sessionId: 'session', messages: [{ ...message, content: 'changed' }] }),
        {},
      ),
      undefined,
    );
  });
});
