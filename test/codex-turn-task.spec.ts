import assert from 'node:assert/strict';

import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import { selectCodexTurnTask } from '../agent/codex-turn-task.ts';

const record = {
  id: 'a'.repeat(64),
  phase: 'creating',
  createdAt: 1,
  sourceThreadId: 'intake',
  request: { prompt: '> assignment card' },
  worktree: '/task',
  context: 'PRIVATE-PROVIDER-PROSE',
  result: { plan: 'OLD-PLAN' },
} as DispatchRecord;
const turn = { threadId: 'native-chat', turnId: 'native-turn' };
const native = { id: turn.threadId, turnId: turn.turnId, cwd: '/task', status: 'active' };
const lookup = {
  find: async () => native,
  receipt: async () => ({ status: 'verified' as const, turnId: turn.turnId, ended: false }),
  path: async (value: string) => value,
} as unknown as Parameters<typeof selectCodexTurnTask>[2];

describe('agent/codex-turn-task', () => {
  it('should resolve the initial native creation before the sender records its thread receipt without writes', async () => {
    const before = structuredClone(record);
    const output = await selectCodexTurnTask([record], turn, {
      ...lookup,
      find: async (input) => {
        assert.deepEqual(input, {
          sourceThreadId: 'intake',
          prompt: record.request!.prompt,
          createdAfter: 1,
          threadId: turn.threadId,
        });
        return native;
      },
    });
    assert.equal(output?.receipt, record.id);
    assert.equal(output?.stage, 'assessment');
    assert.deepEqual(output?.contextRequest, { action: 'context', id: record.id });
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE-PROVIDER-PROSE|OLD-PLAN/);
    assert.deepEqual(record, before);
  });
  it('should resolve the current native turn for delegated input without trusting a supplied turn id', async () => {
    const output = await selectCodexTurnTask([record], { threadId: turn.threadId }, lookup);
    assert.deepEqual(output?.currentTurn, turn);
    await assert.rejects(
      selectCodexTurnTask(
        [record],
        { threadId: turn.threadId },
        {
          ...lookup,
          find: async () => ({ ...native, turnId: undefined }),
        },
      ),
      /turn-context-native-turn-unavailable/,
    );
  });
  it('should ignore unrelated, stale, retired and ambiguous native owners', async () => {
    for (const changed of [
      { threadId: 'other' },
      { supersededBy: 'other' },
      { retired: {} },
      { reset: {} },
      { worktree: '/other' },
    ]) {
      assert.equal(
        await selectCodexTurnTask([{ ...record, ...changed } as DispatchRecord], turn, lookup),
        undefined,
      );
    }
    assert.equal(
      await selectCodexTurnTask([record, { ...record, id: 'b'.repeat(64) }], turn, lookup),
      undefined,
    );
    assert.equal(
      (await selectCodexTurnTask([record], { ...turn, turnId: 'later' }, lookup))?.receipt,
      record.id,
    );
    assert.equal(
      await selectCodexTurnTask([record], turn, {
        ...lookup,
        find: async () => {
          throw new Error('dispatch-native-readback-diverged');
        },
      }),
      undefined,
    );
  });
  it('should map feedback through its exact native send receipt before the sender records a turn id', async () => {
    const feedback = {
      ...structuredClone(record),
      threadId: turn.threadId,
      phase: 'assessing',
      feedback: {
        events: [
          {
            id: 'source',
            native: true,
            source: 'PRIVATE-COMMENT',
            attempt: { request: { threadId: turn.threadId, prompt: '> comment card' } },
          },
        ],
      },
    } as DispatchRecord;
    const before = structuredClone(feedback);
    const output = await selectCodexTurnTask([feedback], turn, lookup);
    assert.deepEqual(output?.feedbackContextRequest, {
      action: 'context',
      id: record.id,
      eventId: 'source',
    });
    assert.equal(output?.stage, 'feedback');
    assert.equal(output?.contextRequest, undefined);
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE-COMMENT/);
    assert.deepEqual(feedback, before);
    const ambiguous = structuredClone(feedback);
    ambiguous.feedback!.events.push({ ...ambiguous.feedback!.events[0]!, id: 'other' });
    assert.equal(
      (await selectCodexTurnTask([ambiguous], turn, lookup))?.feedbackContextRequest,
      undefined,
    );
    feedback.feedback!.events[0]!.attempt!.turnId = 'previous-turn';
    assert.equal(
      (await selectCodexTurnTask([feedback], turn, lookup))?.feedbackContextRequest,
      undefined,
    );
  });
  it('should not invent a feedback mapping from a blocked or uncertain receipt', async () => {
    const feedback = {
      ...record,
      threadId: turn.threadId,
      feedback: {
        events: [
          {
            id: 'source',
            native: true,
            attempt: { request: { threadId: turn.threadId, prompt: '> comment card' } },
          },
        ],
      },
    } as DispatchRecord;
    for (const status of ['uncertain', 'blocked']) {
      const output = await selectCodexTurnTask([feedback], turn, {
        ...lookup,
        receipt: async () =>
          ({ status, code: 'unverified' }) as Awaited<ReturnType<typeof lookup.receipt>>,
      });
      assert.equal(output?.feedbackContextRequest, undefined);
      assert.equal(output?.contextRequest, undefined);
      assert.equal(output?.stage, 'feedback');
    }
  });
  it('should leave verified legacy feedback on its original context path', async () => {
    const legacy = {
      ...record,
      threadId: turn.threadId,
      feedback: {
        events: [
          {
            id: 'source',
            attempt: { request: { threadId: turn.threadId, prompt: '> comment card' } },
          },
        ],
      },
    } as DispatchRecord;
    assert.equal(await selectCodexTurnTask([legacy], turn, lookup), undefined);
  });
  it('should retain implementation on ordinary resumed turns without reinjecting an old plan', async () => {
    const working = {
      ...record,
      threadId: turn.threadId,
      progression: { stage: 'implementation', via: 'work' },
    } as DispatchRecord;
    const output = await selectCodexTurnTask([working], turn, lookup);
    assert.equal(output?.stage, 'implementation');
    assert.equal(output?.contextRuntime, 'continuationRuntime');
    assert.doesNotMatch(JSON.stringify(output), /OLD-PLAN/);
  });
});
