import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

import openClawResponseAuthority from '../agent/openclaw-response-authority.ts';
import continueOpenClawResponse, {
  openClawResponsePending,
} from '../agent/openclaw-response-continuation.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import pendingPublicResponse from '../agent/pending-public-response.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

async function fixture() {
  const cwd = await realpath('/tmp');
  const record = {
    id: 'a'.repeat(64),
    intakeId: 'b'.repeat(64),
    issueKey: 'c'.repeat(64),
    phase: 'complete',
    sourceThreadId: 'intake',
    createdAt: 1,
    manifestDigest: 'd'.repeat(64),
    threadId: 'issue',
    worktree: cwd,
    resultTurnId: 'source',
    assessmentRevision: 1,
    result: {
      version: 1,
      outcome: 'plan-ready',
      summary: 'Plan',
      assessment: 'Plan',
      plan: 'Plan',
      fullAssessment: 'Complete private plan',
      evidence: [],
      progress: { completed: [], remaining: [] },
    },
    request: {
      key: 'issue',
      agentId: 'agent',
      cwd,
      model: 'provider/model',
      thinkingLevel: 'high',
      label: 'Issue',
      category: 'test',
      idempotencyKey: 'create',
    },
    sessionCreation: {
      attempted: true,
      verified: true,
      sessionId: 'incarnation',
      sourceSessionId: 'intake',
      sourceRunId: 'intake-run',
      sourceToolCallId: 'create',
    },
    assessmentTurn: { runId: 'source', message: 'Assess', status: 'completed' },
  } as OpenClawDispatchRecord;
  let active = false,
    ended = false,
    sourceStatus = 'ok',
    cancelled = false,
    posts = 0,
    lose = false;
  let historical:
    | {
        runId?: string;
        truncated?: boolean;
        runTerminal?: boolean;
        sessionId?: string;
        cancelled?: boolean;
        code?: string;
      }
    | undefined;
  const user = (run: string, text: string) => ({
    role: 'user',
    content: text,
    __openclaw: { id: run + ':input', runId: run, idempotencyKey: run + ':user' },
  });
  let recoveryMessage = '';
  const request: DispatchRequest = async (method, params) => {
    if (method === 'sessions.describe')
      return {
        session: {
          key: 'issue',
          agentId: 'agent',
          sessionId: 'incarnation',
          spawnedCwd: cwd,
          model: 'provider/model',
          thinkingLevel: 'high',
        },
      };
    if (method === 'chat.history') {
      const run = params.messageId
        ? String(params.messageId).replace(/:input$/, '')
        : Array.isArray(params.inputRunIds)
          ? String(params.inputRunIds[0])
          : (record.summaryRecovery?.turn.runId ?? 'new');
      const entry = user(run, recoveryMessage || 'Continue');
      const reply = {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Outcome retained.' }],
        __openclaw: {
          id: 'terminal',
          runId: run,
          runTerminal: true,
          ...(run === record.resultTurnId ? historical : {}),
        },
      };
      return {
        sessionId:
          run === record.resultTurnId ? (historical?.sessionId ?? 'incarnation') : 'incarnation',
        messages: params.messageId
          ? [entry]
          : ended || (historical && run === record.resultTurnId)
            ? [entry, reply]
            : [entry],
        inputReceipts:
          historical?.cancelled && run === record.resultTurnId
            ? [
                {
                  runId: run,
                  state: 'consumed',
                  consumedByEventId: run + ':input',
                  cancelled: true,
                },
              ]
            : [],
        pendingInputs: { total: 0 },
        sessionInfo: { hasActiveRun: active, activeLeafEntryId: 'leaf' },
      };
    }
    if (method === 'agent.wait')
      return {
        runId: params.runId,
        status: params.runId === record.resultTurnId ? sourceStatus : ended ? 'ok' : 'timeout',
        ...(cancelled ? { stopReason: 'aborted' } : {}),
        ...(historical?.code ? { code: historical.code } : {}),
      };
    if (method === 'chat.send') {
      assert.equal(record.summaryRecovery!.turn.status, 'attempted');
      assert.equal(saved!.summaryRecovery!.turn.status, 'attempted');
      posts++;
      active = true;
      recoveryMessage = String(params.message);
      if (lose) throw new Error('native response lost');
      return { runId: params.idempotencyKey, status: 'started' };
    }
    throw new Error('unexpected boundary: ' + method);
  };
  let saved: OpenClawDispatchRecord | undefined;
  const save = async () => {
    saved = structuredClone(record);
  };
  const run = () =>
    continueOpenClawResponse({ record, request, config: {}, save, assertCurrent: async () => {} });
  const authority = () =>
    openClawResponseAuthority({
      record,
      request,
      config: {},
      caller: { sessionKey: 'issue', sessionId: 'incarnation', runId: 'new', toolCallId: 'call' },
    });
  return {
    record,
    history: (value: NonNullable<typeof historical> = {}) => {
      historical = value;
      active = true;
    },
    run,
    authority,
    restart: () => {
      Object.assign(record, JSON.parse(JSON.stringify(saved)));
    },
    lose: (value = true) => {
      lose = value;
    },
    end: () => {
      ended = true;
      active = false;
    },
    sourceStatus: (value: string) => {
      sourceStatus = value;
    },
    cancel: () => {
      cancelled = true;
    },
    get posts() {
      return posts;
    },
  };
}

describe('agent/public-response recovery', () => {
  it('should retain the summary obligation before composition and never reset implementation stage', async () => {
    const f = await fixture();
    assert.equal(pendingPublicResponse(f.record)?.state, 'pending');
    f.record.handoff = { at: 2, by: 'issue', turnId: 'work' };
    assert.equal(pendingPublicResponse(f.record)?.state, 'pending');
    assert.equal(f.record.assessmentSummaries, undefined);
  });
  it('should queue only response recovery and reconcile an uncertain native send after restart', async () => {
    const f = await fixture();
    f.lose();
    await assert.rejects(f.run(), /native response lost/);
    const result = structuredClone(f.record.result);
    f.restart();
    f.record.summaryRecovery!.code = 'session-dispatch-chat-send-timeout-unverified';
    assert.equal(openClawResponsePending(f.record), true);
    assert.equal((await f.run())?.status, 'assessment-pending');
    assert.equal(f.posts, 1);
    assert.equal(f.record.summaryRecovery?.turn.status, 'consumed');
    f.end();
    assert.equal((await f.run())?.status, 'assessment-completed');
    assert.equal(openClawResponsePending(f.record), false);
    assert.equal(f.posts, 1);
    assert.deepEqual(f.record.result, result);
    f.record.assessmentRevision = 2;
    f.lose(false);
    await f.run();
    assert.equal(f.posts, 2);
    assert.equal(f.record.previousSummaryTurns?.[0]?.revision, 1);
    assert.match(
      f.record.summaryRecovery!.turn.message,
      /do not repeat assessment or implementation/i,
    );
  });
  it('should authorize a genuinely newer native turn only after the source execution ended', async () => {
    const f = await fixture();
    f.sourceStatus('timeout');
    await assert.rejects(f.authority(), /continuation-not-ready/);
    f.sourceStatus('error');
    await f.authority();
    assert.equal(f.record.resultTurnId, 'source');
    f.cancel();
    await assert.rejects(f.authority(), /turn-cancelled/);
  });
  it('should recover a revised source after native wait state is lost while the recovery turn is active', async () => {
    const f = await fixture();
    f.record.resultTurnId = 'revised-source';
    f.sourceStatus('timeout');
    f.history();
    await f.authority();
    assert.equal(f.record.resultTurnId, 'revised-source');
  });
  it('should reject foreign incomplete cancelled or denied history during recovery', async () => {
    for (const history of [
      { runId: 'foreign' },
      { truncated: true },
      { runTerminal: false },
      { sessionId: 'replacement' },
      { cancelled: true },
      { code: 'approval-denied' },
    ]) {
      const f = await fixture();
      f.sourceStatus('timeout');
      f.history(history);
      await assert.rejects(f.authority());
    }
    const f = await fixture();
    f.sourceStatus('timeout');
    f.history();
    f.cancel();
    await assert.rejects(f.authority(), /turn-cancelled/);
  });
});
