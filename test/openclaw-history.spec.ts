import assert from 'node:assert/strict';

import { completeOpenClawMessage, openClawHistoryPages } from '../agent/openclaw-history.ts';
import { nativeInputEvent } from '../agent/openclaw-session-input.ts';
import { reconcileOpenClawTurn } from '../agent/openclaw-turn.ts';
import type { OpenClawTurn } from '../agent/openclaw-turn-state.ts';
import openClawTurnReply from '../agent/openclaw-turn-evidence.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

const scope = { sessionKey: 'issue', sessionId: 'incarnation' };
const input = {
  role: 'user',
  content: 'complete input',
  __openclaw: { id: 'input', idempotencyKey: 'run:user', runId: 'run' },
};
const terminal = {
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
  __openclaw: { id: 'reply', runId: 'run', runTerminal: true },
};
const shortened = { ...terminal, __openclaw: { ...terminal.__openclaw, truncated: true } };

describe('agent/openclaw-history', () => {
  it('should discover old input beyond the first page and bind the exact session', async () => {
    const calls: string[] = [];
    const result = await nativeInputEvent({
      ...scope,
      runId: 'run',
      retained: [],
      request: async (method, params) => {
        calls.push(method);
        assert.equal(params.maxChars, undefined);
        if (params.messageId) {
          assert.equal(params.sessionId, scope.sessionId);
          return { sessionId: scope.sessionId, messages: [input] };
        }
        return params.cursor
          ? { sessionId: scope.sessionId, messages: [input] }
          : { sessionId: scope.sessionId, messages: [], inputReceipts: [], olderCursor: 'older' };
      },
    });
    assert.equal(result.inputEventId, 'input');
    assert.equal(calls.length, 3);
  });

  it('should fetch complete text for a truncated exact input without raising display limits', async () => {
    const text = 'long input '.repeat(12000);
    const result = await nativeInputEvent({
      ...scope,
      runId: 'run',
      retained: [],
      request: async (method, params) => {
        assert.equal(params.maxChars, undefined);
        if (method === 'chat.message.get') {
          assert.deepEqual(params, { ...scope, messageId: 'input' });
          return { ok: true, message: { ...input, content: text } };
        }
        if (params.messageId)
          return {
            sessionId: scope.sessionId,
            messages: [
              { ...input, content: 'short', __openclaw: { ...input.__openclaw, truncated: true } },
            ],
          };
        return {
          sessionId: scope.sessionId,
          messages: [],
          inputReceipts: [{ runId: 'run', state: 'consumed', consumedByEventId: 'input' }],
        };
      },
    });
    assert.equal(result.message, text);
  });

  it('should recover completion beyond twenty pages and hydrate only its truncated candidate', async () => {
    let page = 0;
    let exact = 0;
    const reply = await openClawTurnReply(
      async (method, params) => {
        if (method === 'chat.message.get') {
          exact++;
          assert.equal(params.messageId, 'reply');
          return { ok: true, message: terminal };
        }
        assert.equal(params.limit, undefined);
        page++;
        return {
          sessionId: scope.sessionId,
          messages: page === 23 ? [shortened] : [],
          ...(page < 23 ? { newerCursor: `page-${page}` } : {}),
        };
      },
      scope,
      'run',
      { messageId: 'input' },
    );
    assert.deepEqual(reply, terminal);
    assert.equal(page, 23);
    assert.equal(exact, 1);
  });

  it('should distinguish missing unavailable truncated and conflicting exact evidence', async () => {
    for (const [result, code] of [
      [{ ok: false, unavailableReason: 'not_found' }, 'missing'],
      [{ ok: false, unavailableReason: 'not_visible' }, 'unavailable'],
      [{ ok: false, unavailableReason: 'oversized' }, 'truncated'],
      [{ ok: true, message: shortened }, 'truncated'],
      [
        {
          ok: true,
          message: { ...terminal, __openclaw: { ...terminal.__openclaw, id: 'foreign' } },
        },
        'conflicting',
      ],
    ] as const) {
      await assert.rejects(
        completeOpenClawMessage(async () => result, scope, shortened),
        new RegExp(`workflow-evidence-${code}`),
      );
    }
    const denial = new Error('session-dispatch-chat-message-get-forbidden');
    await assert.rejects(
      completeOpenClawMessage(
        async () => {
          throw denial;
        },
        scope,
        shortened,
      ),
      (error) => error === denial,
    );
    await assert.rejects(
      completeOpenClawMessage(async () => ({ ok: true, message: input }), scope, {
        ...input,
        idempotencyKey: 'different:user',
        __openclaw: { ...input.__openclaw, truncated: true },
      }),
      /workflow-evidence-conflicting/,
    );
  });

  it('should skip a truncated nonterminal message while finding the required completion', async () => {
    const reply = await openClawTurnReply(
      async (method, params) => {
        assert.equal(method, 'chat.history');
        return params.cursor
          ? { sessionId: scope.sessionId, messages: [terminal] }
          : {
              sessionId: scope.sessionId,
              messages: [{ ...shortened, stopReason: 'toolUse' }],
              olderCursor: 'older',
            };
      },
      scope,
      'run',
    );
    assert.deepEqual(reply, terminal);
  });

  it('should distinguish exhaustion from broken pagination or a replaced session', async () => {
    async function read(request: DispatchRequest) {
      const pages = [];
      for await (const page of openClawHistoryPages(request, scope)) pages.push(page);
      return pages;
    }
    assert.deepEqual(
      await read(async () => ({ sessionId: scope.sessionId, messages: [], hasMore: false })),
      [[]],
    );
    await assert.rejects(
      read(async () => ({ sessionId: scope.sessionId, messages: [], hasMore: true })),
      /workflow-evidence-incomplete/,
    );
    await assert.rejects(
      read(async () => ({ sessionId: scope.sessionId, messages: [], olderCursor: 'cycle' })),
      /workflow-evidence-incomplete/,
    );
    await assert.rejects(
      read(async () => ({ sessionId: 'other', messages: [] })),
      /workflow-evidence-conflicting/,
    );
    let count = 0;
    assert.deepEqual(
      await read(async (_method, params) => {
        count++;
        return params.offset
          ? { sessionId: scope.sessionId, messages: [input], hasMore: false }
          : { sessionId: scope.sessionId, messages: [], hasMore: true, nextOffset: 1 };
      }),
      [[], [input]],
    );
    assert.equal(count, 2);
  });

  it('should reconcile the retained turn after complete evidence returns without another send', async () => {
    const turn: OpenClawTurn = { runId: 'run', message: input.content, status: 'accepted' };
    let available = false;
    let saved = 0;
    const request: DispatchRequest = async (method) => {
      assert.ok(['chat.history', 'chat.message.get', 'agent.wait'].includes(method));
      if (method === 'agent.wait') return { runId: 'run', status: 'ok' };
      if (method === 'chat.message.get')
        return available
          ? { ok: true, message: terminal }
          : { ok: false, unavailableReason: 'oversized' };
      return {
        sessionId: scope.sessionId,
        messages: [input, shortened],
        inputReceipts: [],
        sessionInfo: { hasActiveRun: false },
      };
    };
    const reconcile = () =>
      reconcileOpenClawTurn({
        ...scope,
        turn,
        request,
        save: async () => {
          saved++;
        },
      });
    await assert.rejects(reconcile(), /workflow-evidence-truncated/);
    assert.equal(turn.status, 'consumed');
    assert.equal(turn.consumedByEventId, 'input');
    available = true;
    await reconcile();
    assert.equal(turn.status, 'completed');
    assert.equal(turn.replyEventId, 'reply');
    await reconcile();
    assert.equal(saved, 2);
  });
});
