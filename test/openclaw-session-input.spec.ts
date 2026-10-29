import assert from 'node:assert/strict';

import issueInputEvent, {
  issueInputEventId,
  operatorInputEvent,
} from '../agent/openclaw-session-input.ts';

const turn = { runId: 'owned-run', message: 'exact admitted input' };
const entry = {
  role: 'user',
  content: turn.message,
  idempotencyKey: 'owned-run:user',
  __openclaw: { id: 'input-event', idempotencyKey: 'owned-run:user' },
};

describe('agent/openclaw-session-input', () => {
  it('should adopt native user input custody without requiring assistant run metadata', () => {
    assert.equal(issueInputEvent(entry, turn), 'input-event');
    assert.equal(
      issueInputEvent({ ...entry, __openclaw: { id: 'input-event' } }, turn),
      'input-event',
    );
    assert.equal(issueInputEvent({ ...entry, idempotencyKey: undefined }, turn), 'input-event');
    assert.equal(
      issueInputEvent({ ...entry, __openclaw: { ...entry.__openclaw, runId: turn.runId } }, turn),
      'input-event',
    );
  });

  it('should reject contradictory identity and incomplete input evidence', () => {
    for (const changed of [
      { ...entry, role: 'assistant' },
      { ...entry, content: 'changed input' },
      { ...entry, idempotencyKey: 'other:user' },
      { ...entry, __openclaw: { ...entry.__openclaw, idempotencyKey: 'other:user' } },
      { ...entry, __openclaw: { ...entry.__openclaw, runId: 'other' } },
      { ...entry, __openclaw: { ...entry.__openclaw, id: '' } },
      { ...entry, __openclaw: { ...entry.__openclaw, truncated: true } },
      { ...entry, idempotencyKey: undefined, __openclaw: { id: 'input-event', runId: turn.runId } },
    ]) {
      assert.equal(issueInputEvent(changed, turn), undefined);
    }
  });

  it('should bind followup identity independently of its human-authored content', () => {
    assert.equal(
      issueInputEventId({ ...entry, content: 'a human clarification' }, turn.runId),
      'input-event',
    );
    assert.equal(issueInputEventId(entry, 'unrelated-run'), undefined);
  });

  const owner = {
    ...entry,
    __openclaw: { ...entry.__openclaw, runId: turn.runId, senderIsOwner: true },
  };
  const consumed = { runId: turn.runId, state: 'consumed', consumedByEventId: 'input-event' };
  function verify(
    options: {
      recent?: unknown[];
      exact?: unknown[];
      receipts?: unknown[];
      retained?: Array<{ runId: string; inputEventId: string }>;
      sessionId?: string;
      senderIsOwner?: boolean;
    } = {},
  ) {
    return operatorInputEvent({
      senderIsOwner: options.senderIsOwner ?? true,
      sessionKey: 'issue-chat',
      sessionId: 'original-session',
      runId: turn.runId,
      retained: options.retained ?? [],
      request: async (method, params) => {
        assert.equal(method, 'chat.history');
        if (params.messageId) {
          assert.equal(params.messageId, 'input-event');
          assert.equal(params.sessionId, 'original-session');
          return {
            sessionId: options.sessionId ?? 'original-session',
            messages: options.exact ?? [owner],
          };
        }
        return {
          sessionId: 'original-session',
          messages: options.recent ?? [],
          inputReceipts: options.receipts ?? [consumed],
        };
      },
    });
  }
  it('should resolve an out-of-page owner input from a native consumption receipt', async () => {
    assert.deepEqual(await verify(), {
      runId: turn.runId,
      inputEventId: 'input-event',
      message: turn.message,
    });
    assert.deepEqual(
      await verify({
        exact: [
          { role: 'assistant', __openclaw: { runId: turn.runId, id: 'reply' } },
          owner,
          { role: 'user', __openclaw: { runId: 'other', id: 'other-input' } },
        ],
      }),
      await verify(),
    );
    assert.deepEqual(await verify({ receipts: [], recent: [owner] }), await verify());
    assert.deepEqual(
      await verify({
        receipts: [],
        retained: [{ runId: turn.runId, inputEventId: 'input-event' }],
      }),
      await verify(),
    );
  });
  it('should use trusted owner authority when native history omits owner metadata', async () => {
    const native = { ...owner, __openclaw: { ...entry.__openclaw, runId: turn.runId } };
    assert.deepEqual(await verify({ recent: [native], exact: [native] }), {
      runId: turn.runId,
      inputEventId: 'input-event',
      message: turn.message,
    });
    await assert.rejects(verify({ senderIsOwner: false }), /dispatch-operator-input-unverified/);
  });
  it('should reject missing conflicting cancelled and replaced owner evidence', async () => {
    for (const options of [
      { receipts: [] },
      { receipts: [consumed, consumed] },
      { receipts: [{ ...consumed, cancelled: true }] },
      { receipts: [{ ...consumed, state: 'pending' }] },
      { receipts: [{ ...consumed, consumedByEventId: '' }] },
      { retained: [{ runId: turn.runId, inputEventId: 'other' }] },
      { recent: [owner, owner] },
      { recent: [{ ...owner, idempotencyKey: 'other:user' }] },
      { sessionId: 'replacement-session' },
      { exact: [] },
      { exact: [owner, owner] },
      ...[
        { senderIsOwner: false },
        { id: 'other' },
        { runId: 'other' },
        { idempotencyKey: 'other:user' },
      ].map((meta) => ({ exact: [{ ...owner, __openclaw: { ...owner.__openclaw, ...meta } }] })),
      { exact: [{ ...owner, role: 'assistant' }] },
    ])
      await assert.rejects(verify(options), /dispatch-operator-input-unverified/);
  });
});
