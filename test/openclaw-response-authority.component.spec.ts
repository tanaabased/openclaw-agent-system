import assert from 'node:assert/strict';

import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import openClawResponseAuthority from '../agent/openclaw-response-authority.ts';

describe('agent/openclaw-response-authority', () => {
  const caller = {
    sessionKey: 'issue-chat',
    sessionId: 'original-session',
    runId: 'current-run',
    toolCallId: 'current-call',
  };
  const user = (runId: string, id: string) => ({
    role: 'user',
    content: 'native input',
    idempotencyKey: `${runId}:user`,
    __openclaw: { id, idempotencyKey: `${runId}:user` },
  });
  const current = user(caller.runId, 'current-input');
  const original = user('assessment-run', 'original-input');
  const terminal = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Retained clarification.' }],
    stopReason: 'stop',
    __openclaw: {
      id: 'original-reply',
      runId: 'assessment-run',
      mirrorOrigin: 'codex-app-server',
      runTerminal: true,
    },
  };

  async function verify(
    options: {
      anchor?: boolean;
      conflictingAnchor?: boolean;
      historyAnchor?: boolean;
      oldInput?: typeof original;
      reply?: unknown;
      sessionId?: string;
      pageSessionId?: string;
      cancelled?: boolean;
      repeatCursor?: boolean;
    } = {},
  ) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const record = {
      threadId: caller.sessionKey,
      request: {
        key: caller.sessionKey,
        agentId: 'receiver',
        cwd: process.cwd(),
        model: 'openai/test-model',
        thinkingLevel: 'high',
      },
      sessionCreation: { verified: true, sessionId: caller.sessionId },
      assessmentTurn: {
        runId: 'assessment-run',
        consumedByEventId: options.anchor === false ? undefined : 'original-input',
      },
      assessmentHistory: options.conflictingAnchor
        ? [{ runId: 'assessment-run', inputEventId: 'conflicting-input' }]
        : options.historyAnchor
          ? [{ runId: 'assessment-run', inputEventId: 'original-input' }]
          : [],
      resultTurnId: 'assessment-run',
    } as unknown as OpenClawDispatchRecord;
    await openClawResponseAuthority({
      caller,
      record,
      config: {},
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'sessions.describe')
          return {
            session: {
              key: caller.sessionKey,
              agentId: 'receiver',
              sessionId: caller.sessionId,
              workspaceDir: process.cwd(),
              model: 'openai/test-model',
              thinkingLevel: 'high',
            },
          };
        if (method === 'agent.wait')
          return {
            runId: params.runId,
            status: 'timeout',
            ...(options.cancelled ? { stopReason: 'aborted' } : {}),
          };
        assert.equal(method, 'chat.history');
        if (params.messageId === 'current-input')
          return { sessionId: caller.sessionId, messages: [current] };
        if (params.messageId === 'original-input') {
          assert.equal(params.sessionId, caller.sessionId);
          return {
            sessionId: options.sessionId ?? caller.sessionId,
            messages: [options.oldInput ?? original],
            ...(Number(params.limit) > 1 ? { newerCursor: 'host-page-token' } : {}),
          };
        }
        if (params.cursor) {
          assert.equal(params.cursor, 'host-page-token');
          return {
            sessionId: options.pageSessionId ?? caller.sessionId,
            messages: options.repeatCursor ? [] : [options.reply ?? terminal],
            ...(options.repeatCursor ? { newerCursor: 'host-page-token' } : {}),
          };
        }
        return { sessionId: caller.sessionId, messages: [current], inputReceipts: [] };
      },
    });
    return calls;
  }

  it('should recover an old completed assessment outside the tail without process receipts', async () => {
    const calls = await verify();
    assert.ok(calls.some(({ params }) => params.messageId === 'original-input'));
    assert.ok(calls.some(({ params }) => params.cursor === 'host-page-token'));
  });

  it('should reject an unknown or conflicting historical source', async () => {
    await assert.rejects(verify({ anchor: false }), /dispatch-input-unverified/);
    await assert.rejects(verify({ conflictingAnchor: true }), /dispatch-input-unverified/);
    await assert.rejects(
      verify({ oldInput: user('unrelated-run', 'original-input') }),
      /dispatch-input-unverified/,
    );
  });

  it('should recover a later revision using its retained assessment history source', async () => {
    await verify({ anchor: false, historyAnchor: true });
  });

  it('should reject replaced sessions and cancelled old executions', async () => {
    await assert.rejects(verify({ sessionId: 'replacement' }), /dispatch-input-unverified/);
    await assert.rejects(verify({ cancelled: true }), /dispatch-turn-cancelled/);
    await assert.rejects(
      verify({ pageSessionId: 'replacement' }),
      /dispatch-assessment-continuation-not-ready/,
    );
  });

  it('should require an exact nontruncated terminal reply from the historical execution', async () => {
    for (const meta of [
      { ...terminal.__openclaw, runId: 'unrelated-run' },
      { ...terminal.__openclaw, runTerminal: false },
      { ...terminal.__openclaw, truncated: true },
    ])
      await assert.rejects(
        verify({ reply: { ...terminal, __openclaw: meta } }),
        /dispatch-assessment-continuation-not-ready/,
      );
    await assert.rejects(
      verify({ repeatCursor: true }),
      /dispatch-assessment-continuation-not-ready/,
    );
  });
});
