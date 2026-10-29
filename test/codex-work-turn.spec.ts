import assert from 'node:assert/strict';

import advance from '../agent/codex-work-turn.ts';
import { automationHash } from '../agent/automation-hash.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import type { CodexWorkContext } from '../agent/codex-continuation-context.ts';

function fixture() {
  const source = { turnId: 'work', inputId: 'original-input' };
  const record = {
    id: 'issue',
    sourceThreadId: 'intake',
    threadId: 'chat',
    worktree: '/tmp',
    request: {},
    result: { outcome: 'plan-ready' },
    resultTurnId: 'assessment',
    progression: { stage: 'implementation', via: 'work', workOwner: 'issue' },
    continuation: {
      phase: 'running',
      scope: 'local',
      selection: { observedAt: 1 },
      policyDigest: 'policy',
      assessmentDigest: 'assessment',
      attempt: {
        id: 'attempt',
        origin: 'input',
        inputId: source.inputId,
        sourceThreadId: 'chat',
        sourceTurnId: source.turnId,
        beforeTurnId: source.turnId,
        turnId: source.turnId,
        request: { threadId: 'chat', prompt: 'Authorized work.' },
      },
    },
  } as DispatchRecord;
  const receipts: string[] = [];
  const context = {
    records: [record],
    input: { action: 'next' },
    current: { policy: { policy: { maxConcurrentItems: 1 } }, manifest: {}, workspace: '/tmp' },
    caller: 'intake',
    activation: { sourceThreadId: 'intake' },
    occurrence: { id: 'scan' },
    deps: { now: () => 10 },
    native: { assessmentSkill: async () => ({ id: 'implementation' }) },
    continuationNative: async (_: string, attempt: { inputId: string; turnId: string }) => {
      receipts.push(attempt.inputId);
      return { status: 'verified', turnId: attempt.turnId, ended: true };
    },
    save: async () => {},
  } as unknown as CodexWorkContext;
  const verified = {
    admitted: { id: 'admitted', repository: { nodeId: 'repo' }, issue: { nodeId: 'issue' } },
    selection: record.continuation!.selection,
    found: {
      id: 'chat',
      cwd: '/tmp',
      turnId: 'work',
      status: 'idle',
      turnStatus: 'completed',
      turnEnded: true,
      followUpUserTurn: true,
    },
    transition: { status: 'ready', progression: record.progression },
    liveMode: 'work',
    authorizeLive: async () => {},
    resumeBlocked: false,
  } as unknown as Parameters<typeof advance>[2];
  return { record, context, verified, source, receipts };
}

describe('agent/codex-work-turn', () => {
  it('should recover an interrupted handoff through its retained input without preparing a duplicate send', async () => {
    const { record, context, verified, source, receipts } = fixture();
    delete record.continuation!.attempt;
    record.handoff = { at: 1, by: 'chat', ...source };
    const result = await advance(record, context, verified);
    assert.equal(result.ready, true);
    if (result.ready) assert.equal(result.currentTurnEnded, true);
    assert.deepEqual(receipts, ['original-input']);
    assert.equal(record.handoff, undefined);
    assert.equal(record.continuation!.handoffs?.[0]?.inputId, source.inputId);
    assert.equal(record.continuation!.scope, 'local');
    assert.equal(
      (record.continuation as NonNullable<DispatchRecord['continuation']>).attempt?.origin,
      'input',
    );
  });

  it('should require explicit context for an older handoff without input custody', async () => {
    const { record, context, verified } = fixture();
    delete record.continuation!.attempt;
    record.handoff = { at: 1, by: 'chat', turnId: 'unknown' };
    await assert.rejects(advance(record, context, verified), /handoff-input-unverified/);
    assert.equal(record.continuation!.attempt, undefined);
  });

  it('should preserve a denial while reconciling an interrupted handoff', async () => {
    const { record, context, verified, source } = fixture();
    delete record.continuation!.attempt;
    record.handoff = { at: 1, by: 'chat', ...source };
    context.continuationNative = async () => ({
      status: 'blocked',
      code: 'continuation-native-approval-denied',
      turnId: 'work',
      ended: true,
    });
    const result = await advance(record, context, verified);
    assert.equal(result.ready, false);
    assert.equal(record.continuation!.phase, 'blocked');
    assert.equal(record.continuation!.code, 'continuation-native-approval-denied');
    assert.ok(record.handoff);
  });

  it('should enforce shared capacity at preparation instead of reserving idle queued work forever', async () => {
    const { record, context, verified } = fixture();
    delete record.continuation!.attempt;
    record.nativeInactive = true;
    context.records.push({
      ...record,
      id: 'busy',
      nativeInactive: false,
      capacityObservation: { at: 2, code: 'dispatch-capacity-native-active' },
    });
    assert.equal((await advance(record, context, verified)).ready, false);
    assert.equal(record.continuation!.attempt, undefined);
    context.records.pop();
    const prepared = await advance(record, context, verified);
    assert.equal(prepared.ready, false);
    if (!prepared.ready) assert.equal(prepared.response?.status, 'prepared');
    assert.equal(record.nativeInactive, undefined);
    assert.equal(
      (record.continuation as NonNullable<DispatchRecord['continuation']>).attempt?.origin,
      undefined,
    );
  });

  for (const outcome of ['done', 'clarification-needed', 'blocked'] as const)
    it(`should consume a fresh same-turn input after ${outcome} and preserve the prior result and local scope`, async () => {
      const { record, context, verified, source, receipts } = fixture();
      const work = record.continuation!;
      const previous = {
        outcome,
        summary: 'Retained work.',
        fullResult: 'Original result.',
        ...(outcome === 'clarification-needed' ? { questions: ['Which option?'] } : {}),
      } as NonNullable<typeof work.result>;
      work.result = previous;
      work.resultSource = source;
      work.phase = outcome === 'done' ? 'complete' : outcome;
      context.input.action = 'context';
      context.caller = 'chat';
      context.operatorInput = { turnId: 'work', inputId: 'new-steering' };
      verified.found.status = 'active';
      verified.found.turnStatus = 'inProgress';
      verified.found.turnEnded = false;
      verified.resumeBlocked = outcome === 'blocked';
      const result = await advance(record, context, verified);
      assert.equal(result.ready, true);
      assert.equal(work.result, undefined);
      assert.deepEqual(work.resultHistory, [{ source, result: previous }]);
      assert.deepEqual(work.revisionSource, context.operatorInput);
      assert.deepEqual(receipts, ['original-input', 'new-steering']);
      assert.equal(work.scope, 'local');
      assert.equal(work.phase, 'running');
      const prior = automationHash(work.resultHistory);
      await advance(record, context, verified);
      assert.equal(automationHash(work.resultHistory), prior);
    });
});
