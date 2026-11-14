import assert from 'node:assert/strict';

import issueInputEvent, {
  issueInputEventId,
  nativeInputEvent,
  operatorInputEvent,
} from '../agent/openclaw-session-input.ts';

import workflowFailure from '../agent/tasks/workflow-failure.ts';

const turn = { runId: 'owned-run', message: 'exact admitted input' };
const entry = {
  role: 'user',
  content: turn.message,
  idempotencyKey: 'owned-run:user',
  __openclaw: { id: 'input-event', idempotencyKey: 'owned-run:user' },
};

describe('agent/openclaw-session-input', () => {
  it('should locate history failures while preserving rpc codes and custody reasons', async () => {
    for (const error of [
      new TypeError('SECRET history /private/path'),
      new Error('session-dispatch-history-forbidden'),
      new Error('session-dispatch-history-timeout-unverified'),
    ]) {
      await assert.rejects(
        nativeInputEvent({
          sessionKey: 'SECRET',
          sessionId: 'SECRET',
          runId: 'SECRET',
          retained: [],
          request: async () => {
            throw error;
          },
        }),
        (caught) => {
          assert.equal(caught, error);
          const failure = workflowFailure(caught, 'dispatch-operation-failed');
          assert.equal(
            failure.code,
            error instanceof TypeError ? 'dispatch-operation-failed' : error.message,
          );
          assert.deepEqual(failure.failureDiagnostic, {
            step: 'input-verification',
            category: error instanceof TypeError ? 'type-error' : 'error',
          });
          assert.doesNotMatch(JSON.stringify(failure), /SECRET|private/);
          return true;
        },
      );
    }
    await assert.rejects(verify({ receipts: [{ ...consumed, cancelled: true }] }), (error) => {
      const failure = workflowFailure(error, 'fallback');
      assert.equal(failure.code, 'dispatch-operator-input-unverified');
      assert.equal(failure.inputVerificationReason, 'input-receipt-invalid-or-cancelled');
      assert.equal(failure.failureDiagnostic?.step, 'input-verification');
      return true;
    });
  });

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
      native?: boolean;
      runId?: string;
      inputId?: string;
      recent?: unknown[];
      exact?: unknown[];
      receipts?: unknown[];
      retained?: Array<{ runId: string; inputEventId: string }>;
      sessionId?: string;
      senderIsOwner?: boolean;
    } = {},
  ) {
    const read = options.native ? nativeInputEvent : operatorInputEvent;
    return read({
      senderIsOwner: options.senderIsOwner ?? true,
      sessionKey: 'issue-chat',
      sessionId: 'original-session',
      runId: options.runId ?? turn.runId,
      inputId: options.inputId,
      retained: options.retained ?? [],
      request: async (method, params) => {
        assert.equal(method, 'chat.history');
        if (params.messageId) {
          assert.equal(params.sessionId, 'original-session');
          return {
            sessionId: options.sessionId ?? 'original-session',
            messages: (options.exact ?? [owner]).filter(
              (entry) => (entry as typeof owner).__openclaw?.id === params.messageId,
            ),
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
  it('should resolve forwarded display inputs under native owner authority', async () => {
    const forwarded = {
      ...owner,
      role: 'assistant',
      provenance: {
        kind: 'inter_session',
        sourceTool: 'sessions_send',
        sourceSessionKey: 'agent:sender:main',
      },
      __openclaw: { ...owner.__openclaw, senderIsOwner: false },
    };
    const options = {
      native: true,
      inputId: 'owned-run:user',
      receipts: [],
      recent: [forwarded],
      exact: [forwarded],
    };
    const expected = { runId: turn.runId, inputEventId: 'input-event', message: turn.message };
    assert.equal(
      issueInputEventId(
        { ...forwarded, __openclaw: { ...forwarded.__openclaw, truncated: true } },
        turn.runId,
      ),
      undefined,
    );
    assert.deepEqual(await verify(options), expected);
    assert.deepEqual(await verify({ ...options, inputId: 'input-event' }), expected);
    for (const inputId of ['owned-run:user', 'input-event']) {
      for (const senderIsOwner of [true, undefined]) {
        const authorized = { ...forwarded, __openclaw: { ...owner.__openclaw, senderIsOwner } };
        const ownerOptions = {
          ...options,
          inputId,
          native: false,
          recent: [authorized],
          exact: [authorized],
        };
        assert.deepEqual(await verify(ownerOptions), expected);
        await assert.rejects(
          verify({ ...ownerOptions, senderIsOwner: false }),
          /dispatch-operator-input-unverified/,
        );
      }
      await assert.rejects(
        verify({ ...options, inputId, native: false }),
        /dispatch-operator-input-unverified/,
      );
    }
    const authorized = {
      ...forwarded,
      __openclaw: { ...forwarded.__openclaw, senderIsOwner: true },
    };
    const ownerOptions = { ...options, native: false, recent: [authorized], exact: [authorized] };
    for (const change of [
      { receipts: [{ ...consumed, cancelled: true }] },
      { receipts: [{ ...consumed, state: 'pending' }] },
      { receipts: [{ ...consumed, consumedByEventId: 'other' }] },
      { recent: [authorized, authorized] },
      { exact: [authorized, authorized] },
      { sessionId: 'replacement' },
      { exact: [{ ...authorized, idempotencyKey: 'other:user' }] },
      { exact: [{ ...authorized, __openclaw: { ...authorized.__openclaw, runId: 'other' } }] },
    ])
      await assert.rejects(
        verify({ ...ownerOptions, ...change }),
        /dispatch-operator-input-unverified/,
      );
    for (const provenance of [
      undefined,
      { kind: 'external_user', sourceTool: 'sessions_send' },
      { kind: 'inter_session', sourceTool: 'other' },
    ]) {
      const assistant = { ...authorized, provenance, senderLabel: 'Forwarded agent message' };
      assert.equal(issueInputEventId(assistant, turn.runId), undefined);
      await assert.rejects(
        verify({ ...ownerOptions, recent: [assistant], exact: [assistant] }),
        /dispatch-operator-input-unverified/,
      );
    }
  });

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
  it('should verify the exact native input independently of execution identity and queued neighbors', async () => {
    const exact = {
      ...owner,
      __openclaw: { ...owner.__openclaw, runId: 'resumed-execution' },
    };
    const options = {
      inputId: 'input-event',
      runId: 'resumed-execution',
      recent: [
        {
          ...owner,
          idempotencyKey: 'queued-run:user',
          __openclaw: {
            ...owner.__openclaw,
            id: 'queued-input',
            idempotencyKey: 'queued-run:user',
          },
        },
      ],
      exact: [exact],
      retained: [{ runId: 'resumed-execution', inputEventId: 'previous-input' }],
    };
    assert.deepEqual(await verify(options), {
      runId: 'resumed-execution',
      inputEventId: 'input-event',
      message: turn.message,
    });
    assert.deepEqual(
      await verify({ ...options, inputId: 'owned-run:user' }),
      await verify(options),
    );
    for (const change of [
      { receipts: [{ ...consumed, cancelled: true }] },
      { receipts: [{ ...consumed, state: 'pending' }] },
      { receipts: [{ ...consumed, consumedByEventId: 'queued-input' }] },
      { exact: [owner] },
      { exact: [] },
      { exact: [exact, exact] },
      { sessionId: 'replacement-session' },
      { exact: [{ ...exact, __openclaw: { ...exact.__openclaw, senderIsOwner: false } }] },
      { exact: [{ ...exact, idempotencyKey: 'other:user' }] },
    ])
      await assert.rejects(verify({ ...options, ...change }), /dispatch-operator-input-unverified/);
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

  it('should resolve a hook submission key on the initial run without assistant run metadata', async () => {
    assert.deepEqual(await verify({ inputId: 'owned-run:user', exact: [entry] }), {
      runId: turn.runId,
      inputEventId: 'input-event',
      message: turn.message,
    });
  });

  it('should search older pages by exact submission key without adopting neighboring or retained input', async () => {
    const scope = { sessionKey: 'issue-chat', sessionId: 'original-session' };
    const lookup = async (includeInput: boolean) =>
      nativeInputEvent({
        ...scope,
        runId: 'resumed-run',
        inputId: 'owned-run:user',
        retained: [{ runId: 'resumed-run', inputEventId: 'unrelated' }],
        request: async (_method, params) => {
          if (params.messageId) {
            assert.equal(params.messageId, 'input-event');
            assert.equal(params.sessionId, scope.sessionId);
            return { sessionId: scope.sessionId, messages: [entry] };
          }
          if (params.cursor) {
            assert.equal(params.cursor, 'older');
            return { sessionId: scope.sessionId, messages: includeInput ? [entry] : [] };
          }
          assert.deepEqual(params.inputRunIds, ['owned-run']);
          return {
            sessionId: scope.sessionId,
            inputReceipts: [],
            olderCursor: 'older',
            messages: [
              {
                ...entry,
                idempotencyKey: 'resumed-run:user',
                __openclaw: { id: 'unrelated', idempotencyKey: 'resumed-run:user' },
              },
            ],
          };
        },
      });
    assert.equal((await lookup(true)).inputEventId, 'input-event');
    await assert.rejects(lookup(false), {
      message: 'dispatch-input-unverified',
      inputVerificationReason: 'bound-input-missing',
    });
    for (const change of [
      { receipts: [consumed, consumed] },
      { receipts: [{ ...consumed, cancelled: true }] },
      { receipts: [{ ...consumed, state: 'pending' }] },
      { receipts: [{ ...consumed, consumedByEventId: 'other' }] },
      { exact: [entry, entry] },
      { exact: [] },
      { receipts: [], recent: [entry, entry] },
      { exact: [{ ...entry, idempotencyKey: 'other:user' }] },
      { sessionId: 'replacement-session' },
    ])
      await assert.rejects(
        verify({ inputId: 'owned-run:user', ...change }),
        /dispatch-operator-input-unverified/u,
      );
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
