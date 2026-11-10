import assert from 'node:assert/strict';

import type { CodexWorkContext } from '../agent/codex-continuation-context.ts';
import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import advance from '../agent/codex-work-turn.ts';

function fixture() {
  const source = { turnId: 'work', inputId: 'original-input' };
  const record = {
    id: 'issue',
    sourceThreadId: 'intake',
    threadId: 'chat',
    worktree: '/tmp',
    request: {},
    progression: { stage: 'implementation', via: 'work' },
    nativeWork: {
      scope: 'local',
      selection: { observedAt: 1 },
      policyDigest: 'policy',
    },
  } as DispatchRecord;
  const receipts: string[] = [];
  const context = {
    records: [record],
    input: { action: 'context' },
    current: { policy: { policy: { maxConcurrentItems: 1 } }, manifest: {}, workspace: '/tmp' },
    caller: 'chat',
    activation: { sourceThreadId: 'intake' },
    occurrence: { id: 'scan' },
    deps: { now: () => 10 },
    native: { assessmentSkill: async () => ({ id: 'implementation' }) },
    continuationNative: async (_: string, attempt: { inputId: string; turnId: string }) => {
      receipts.push(attempt.inputId);
      return { status: 'verified', turnId: attempt.turnId, ended: false };
    },
    save: async () => {},
  } as unknown as CodexWorkContext;
  const verified = {
    admitted: { id: 'admitted', repository: { nodeId: 'repo' }, issue: { nodeId: 'issue' } },
    selection: record.nativeWork!.selection,
    found: {
      id: 'chat',
      cwd: '/tmp',
      turnId: 'work',
      status: 'active',
      turnStatus: 'inProgress',
      turnEnded: false,
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
  it('should expose a recoverable observation reason and retain the decision only after a fresh read', async () => {
    const { record, context, verified } = fixture();
    delete record.progression;
    verified.found.turnStatus = 'interrupted';
    record.nativeWork!.observation = { turnId: 'work', afterItemId: 'boundary' };
    context.observeTurn = async () => ({
      status: 'unresolved',
      reason: 'native-observation-superseded',
    });
    const pending = await advance(record, context, verified);
    assert.equal(pending.ready, false);
    if (!pending.ready) {
      assert.equal(
        'reason' in pending.response && pending.response.reason,
        'native-observation-superseded',
      );
      assert.equal('request' in pending.response, false);
    }
    assert.equal(record.progression, undefined);
    context.observeTurn = async () => ({ status: 'active', receiptId: 'fresh-read' });
    assert.equal((await advance(record, context, verified)).ready, true);
    assert.equal((record as DispatchRecord).progression?.stage, 'implementation');
    assert.equal(record.nativeWork!.observation.receiptId, 'fresh-read');
  });

  it('should bind current work to the exact verified feedback receipt', async () => {
    const { record, context, verified } = fixture();
    verified.found.turnId = 'feedback';
    const attempt = {
      id: 'f'.repeat(64),
      sourceThreadId: 'intake',
      sourceTurnId: 'scan',
      beforeTurnId: 'assessment',
      turnId: 'feedback',
      request: { threadId: 'chat', prompt: 'Verified feedback input.' },
    };
    context.feedbackInput = {
      turnId: 'feedback',
      inputId: attempt.id,
      attempt,
      authorize: async () => {},
    };
    context.continuationNative = async (_source, received) => {
      assert.deepEqual(received, attempt);
      return { status: 'verified', turnId: 'feedback', ended: false };
    };
    assert.equal((await advance(record, context, verified)).ready, true);
    assert.equal(record.nativeWork!.binding!.turnId, 'feedback');
  });

  it('should enter work without saving a plan or creating a coordinator request', async () => {
    const { record, context, verified } = fixture();
    assert.equal((await advance(record, context, verified)).ready, true);
    assert.equal(record.nativeWork!.binding!.turnId, 'work');
  });

  it('should preserve current native denials without mutating prior receipts', async () => {
    const { record, context, verified } = fixture();
    const before = structuredClone(record);
    context.continuationNative = async () => ({
      status: 'blocked',
      code: 'continuation-native-approval-denied',
      turnId: 'work',
      ended: false,
    });
    const result = await advance(record, context, verified);
    assert.equal(result.ready, false);
    if (!result.ready) assert.equal(result.response.code, 'continuation-native-approval-denied');
    assert.deepEqual(record, before);
  });

  it('should leave an ended native turn to its host without preparing another send', async () => {
    const { record, context, verified, receipts } = fixture();
    verified.found.turnEnded = true;
    const before = structuredClone(record);
    assert.equal((await advance(record, context, verified)).ready, false);
    assert.deepEqual(record, before);
    assert.deepEqual(receipts, []);
  });
});
