import assert from 'node:assert/strict';

import type { OpenClawDispatchRecord } from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
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

  for (const selected of [false, true])
    for (const inputId of ['input', 'send-one:user'])
      it(`should resolve ${selected ? 'selected' : 'queued'} feedback by ${inputId}`, async () => {
        const owned = structuredClone(record);
        owned.request = { key: 'chat', agentId: 'agent' } as OpenClawDispatchRecord['request'];
        if (selected)
          owned.feedback!.context = {
            runId: caller.runId,
            eventId: 'first',
            inputEventId: 'input',
          };
        const before = structuredClone(owned);
        const result = await resolveOpenClawTurnFeedback(
          owned,
          { ...caller, inputId },
          async (method) =>
            method === 'sessions.describe'
              ? { session: { key: 'chat', agentId: 'agent', sessionId: 'session' } }
              : {
                  sessionId: 'session',
                  messages: [message],
                  inputReceipts: [
                    { runId: 'send-one', state: 'consumed', consumedByEventId: 'input' },
                  ],
                },
          {},
        );
        assert.equal(result?.event.id, 'first');
        assert.equal(result?.inputId, 'input');
        assert.deepEqual(owned, before);
      });

  it('should keep distinct queued sources bound to their exact native identifiers', async () => {
    const second = {
      role: 'user',
      content: 'second comment',
      __openclaw: { id: 'second-input', runId: 'execution', idempotencyKey: 'send-two:user' },
    };
    for (const inputId of ['send-two:user', 'second-input']) {
      const result = await resolveOpenClawTurnFeedback(
        record,
        { ...caller, inputId },
        async (_method, params) => ({
          sessionId: 'session',
          messages: params.messageId
            ? [message, second].filter((entry) => entry.__openclaw.id === params.messageId)
            : [message, second],
        }),
        {},
      );
      assert.equal(result?.event.id, 'second');
      assert.equal(result?.inputId, 'second-input');
    }
  });

  it('should not redirect an explicitly selected source to another valid native input', async () => {
    const selected = structuredClone(record);
    selected.request = { key: 'chat', agentId: 'agent' } as OpenClawDispatchRecord['request'];
    selected.feedback!.context = { runId: caller.runId, eventId: 'first', inputEventId: 'input' };
    const second = {
      role: 'user',
      content: 'second comment',
      __openclaw: { id: 'second-input', runId: 'execution', idempotencyKey: 'send-two:user' },
    };
    await assert.rejects(
      resolveOpenClawTurnFeedback(
        selected,
        { ...caller, inputId: 'send-two:user' },
        async (method, params) =>
          method === 'sessions.describe'
            ? { session: { key: 'chat', agentId: 'agent', sessionId: 'session' } }
            : {
                sessionId: 'session',
                messages: params.messageId
                  ? [message, second].filter((entry) => entry.__openclaw.id === params.messageId)
                  : [message, second],
              },
        {},
      ),
      /feedback-input-unverified/,
    );
  });

  it('should reject conflicting, cancelled, ambiguous and foreign native input evidence', async () => {
    for (const mutation of [
      'cancelled',
      'conflict',
      'duplicate',
      'session',
      'key',
      'run',
      'missing',
    ]) {
      const changed = structuredClone(message);
      if (mutation === 'key') changed.__openclaw.idempotencyKey = 'send-two:user';
      if (mutation === 'run') changed.__openclaw.runId = 'another-execution';
      await assert.rejects(
        resolveOpenClawTurnFeedback(
          record,
          { ...caller, inputId: 'send-one:user' },
          async () => ({
            sessionId: mutation === 'session' ? 'replacement' : 'session',
            messages:
              mutation === 'missing'
                ? []
                : mutation === 'duplicate'
                  ? [changed, changed]
                  : [changed],
            inputReceipts: [
              {
                runId: 'send-one',
                state: 'consumed',
                consumedByEventId: mutation === 'conflict' ? 'another-input' : 'input',
                cancelled: mutation === 'cancelled',
              },
            ],
          }),
          {},
        ),
        /dispatch-input-unverified/,
      );
    }
    await assert.rejects(
      resolveOpenClawTurnFeedback(
        record,
        { ...caller, sessionKey: 'foreign', inputId: 'send-one:user' },
        async () => ({}),
        {},
      ),
      /reply-managed-context-invalid/,
    );
    const duplicate = structuredClone(record);
    duplicate.feedback!.events.push({ ...duplicate.feedback!.events[0]!, id: 'duplicate' });
    await assert.rejects(
      resolveOpenClawTurnFeedback(
        duplicate,
        { ...caller, inputId: 'send-one:user' },
        async () => ({ sessionId: 'session', messages: [message] }),
        {},
      ),
      /feedback-native-input-ambiguous/,
    );
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
