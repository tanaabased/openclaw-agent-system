import assert from 'node:assert/strict';

import type { DispatchRecord } from '../agent/codex-dispatch-state.ts';
import codexContinuationNative from '../agent/codex-continuation-native.ts';
import { selectCodexTurnTask } from '../agent/codex-turn-task.ts';

const record = {
  id: 'a'.repeat(64),

  createdAt: 1,
  sourceThreadId: 'intake',
  request: { prompt: '> assignment card' },
  context: 'PRIVATE-PROVIDER-PROSE',
} as DispatchRecord;
const turn = { threadId: 'native-chat', turnId: 'native-turn' };
const native = { id: turn.threadId, turnId: turn.turnId, cwd: '/task', status: 'active' };
const lookup = {
  find: async () => native,
  receipt: async () => ({ status: 'verified' as const, turnId: turn.turnId, ended: false }),
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
    assert.equal(output?.worktree, native.cwd);
    assert.deepEqual(output?.contextRequest, { action: 'context' });
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE-PROVIDER-PROSE/);
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
  it('should ignore unrelated, stale and reset native owners', async () => {
    for (const changed of [
      { threadId: 'other' },
      { supersededBy: 'other' },
      { reset: {} },
      { reset: {} },
    ]) {
      assert.equal(
        await selectCodexTurnTask([{ ...record, ...changed } as DispatchRecord], turn, lookup),
        undefined,
      );
    }
    await assert.rejects(
      selectCodexTurnTask([record, { ...record, id: 'b'.repeat(64) }], turn, lookup),
      /turn-context-owner-ambiguous/,
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
  it('should distinguish an unverified active owner from an unmanaged native chat', async () => {
    const owned = { ...record, threadId: turn.threadId };
    for (const find of [
      async () => undefined,
      async () => {
        throw new Error('dispatch-native-readback-diverged');
      },
    ])
      await assert.rejects(
        selectCodexTurnTask([owned], turn, { ...lookup, find }),
        /turn-context-owner-unverified/,
      );
    await assert.rejects(
      selectCodexTurnTask([owned, { ...owned, id: 'b'.repeat(64) }], turn, lookup),
      /turn-context-owner-ambiguous/,
    );
    await assert.rejects(
      selectCodexTurnTask([{ ...owned, request: undefined }], turn, lookup),
      /turn-context-owner-unverified/,
    );
    assert.equal(await selectCodexTurnTask([], turn, lookup), undefined);
  });
  it('should retain the assigned checkout when the native working directory changes', async () => {
    const output = await selectCodexTurnTask([{ ...record, worktree: '/task' }], turn, {
      ...lookup,
      find: async () => ({ ...native, cwd: '/another-checkout' }),
    });
    assert.equal(output?.worktree, '/task');
    assert.equal(output?.nativeCwd, '/another-checkout');
    assert.deepEqual(output?.contextRequest, { action: 'context' });
  });
  it('should verify the known owner independently of another pending creation', async () => {
    const pending = {
      ...record,
      id: 'pending',
      request: { prompt: 'other assignment' },
    } as DispatchRecord;
    const owned = { ...record, threadId: turn.threadId };
    const find = async (input: Parameters<LookupFind>[0]) => {
      if (input.prompt === pending.request!.prompt)
        throw new Error('unrelated history unavailable');
      return native;
    };
    type LookupFind = Parameters<typeof selectCodexTurnTask>[2]['find'];
    const selected = await selectCodexTurnTask([pending, owned], turn, { ...lookup, find });
    assert.equal(selected?.receipt, owned.id);
    await assert.rejects(
      selectCodexTurnTask([pending, owned], turn, { ...lookup, find: async () => undefined }),
      /turn-context-owner-unverified/,
    );
  });
  it('should map feedback through its exact native send receipt before the sender records a turn id', async () => {
    const feedback = {
      ...structuredClone(record),
      threadId: turn.threadId,

      feedback: {
        events: [
          {
            id: 'source',
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
  it('should preserve the verified task when exact feedback receipt inspection fails', async () => {
    const feedback = {
      ...record,
      threadId: turn.threadId,
      feedback: {
        events: [
          {
            id: 'source',
            attempt: { request: { threadId: turn.threadId, prompt: '> comment' } },
          },
        ],
      },
    } as DispatchRecord;
    const before = structuredClone(feedback);
    const output = await selectCodexTurnTask([feedback], turn, {
      ...lookup,
      receipt: async () => {
        throw new Error('private transport failure');
      },
    });
    assert.equal(output?.receipt, record.id);
    assert.equal(output?.stage, 'feedback');
    assert.equal(output?.feedbackContextRequest, undefined);
    assert.deepEqual(output?.feedbackLimitation, { code: 'feedback-native-input-unavailable' });
    assert.doesNotMatch(JSON.stringify(output), /private transport failure/);
    assert.deepEqual(feedback, before);
    const recovered = await selectCodexTurnTask([feedback], turn, lookup);
    assert.equal(recovered?.feedbackContextRequest?.eventId, 'source');
    assert.equal(recovered?.feedbackLimitation, undefined);
  });

  it('should not invent a feedback mapping from a blocked or uncertain receipt', async () => {
    const feedback = {
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
    for (const status of ['uncertain', 'blocked', 'mismatch']) {
      const output = await selectCodexTurnTask([feedback], turn, {
        ...lookup,
        receipt: async () =>
          ({
            status,
            code: 'continuation-send-mismatch',
            callId: 'send',
            requestDigest: 'a'.repeat(64),
            turnId: turn.turnId,
            latestTurnId: turn.turnId,
            ended: false,
          }) as Awaited<ReturnType<typeof lookup.receipt>>,
      });
      assert.equal(output?.feedbackContextRequest, undefined);
      assert.equal(output?.contextRequest, undefined);
      assert.equal(output?.stage, 'feedback');
      if (status === 'mismatch')
        assert.deepEqual(output?.feedbackLimitation, { code: 'continuation-send-mismatch' });
    }
  });
  it('should select the exact feedback source verified by its native send receipt', async () => {
    const feedback = {
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
    assert.equal(
      (await selectCodexTurnTask([feedback], turn, lookup))?.feedbackContextRequest?.eventId,
      'source',
    );
  });

  for (const outcome of ['uncertain', 'mismatch', 'blocked', 'unavailable'] as const)
    it(`should isolate an older ${outcome} receipt from verified current feedback`, async () => {
      const feedback = {
        ...record,
        threadId: turn.threadId,
        feedback: {
          events: ['old', 'current'].map((id) => ({
            id,
            attempt: { id, request: { threadId: turn.threadId, prompt: id } },
          })),
        },
      } as DispatchRecord;
      const before = structuredClone(feedback);
      const output = await selectCodexTurnTask([feedback], turn, {
        ...lookup,
        receipt: async (_source, attempt) => {
          if (attempt.id === 'current')
            return { status: 'verified', turnId: turn.turnId, ended: false };
          if (outcome === 'unavailable') throw new Error('old history unavailable');
          if (outcome === 'uncertain') return { status: 'uncertain' };
          if (outcome === 'blocked')
            return { status: 'blocked', code: 'continuation-native-send-failed' };
          return {
            status: 'mismatch',
            code: 'continuation-send-mismatch',
            turnId: 'old-turn',
            latestTurnId: turn.turnId,
            callId: 'old-send',
            requestDigest: 'a'.repeat(64),
            ended: true,
          };
        },
      });
      assert.equal(output?.feedbackContextRequest?.eventId, 'current');
      assert.equal(output?.feedbackLimitation, undefined);
      assert.deepEqual(feedback, before);
    });

  it('should retain a current-turn denial and conflicting verified sources', async () => {
    const feedback = {
      ...record,
      threadId: turn.threadId,
      feedback: {
        events: ['one', 'two'].map((id) => ({
          id,
          attempt: { id, request: { threadId: turn.threadId, prompt: id } },
        })),
      },
    } as DispatchRecord;
    const denied = await selectCodexTurnTask([feedback], turn, {
      ...lookup,
      receipt: async (_source, attempt) =>
        attempt.id === 'one'
          ? {
              status: 'blocked',
              code: 'continuation-native-approval-denied',
              turnId: turn.turnId,
              ended: false,
            }
          : { status: 'verified', turnId: turn.turnId, ended: false },
    });
    assert.equal(denied?.feedbackContextRequest, undefined);
    assert.equal(denied?.feedbackLimitation?.code, 'continuation-native-approval-denied');
    const ambiguous = await selectCodexTurnTask([feedback], turn, lookup);
    assert.equal(ambiguous?.feedbackContextRequest, undefined);
    assert.equal(ambiguous?.feedbackLimitation?.code, 'feedback-native-input-ambiguous');
  });

  it('should select current structured feedback through real native receipts after a mismatched earlier send', async () => {
    const events = ['old', 'current'].map((id) => ({
      id,
      attempt: {
        id,
        sourceThreadId: 'intake',
        sourceTurnId: `scan-${id}`,
        beforeTurnId: 'initial',
        request: { threadId: turn.threadId, prompt: `${id} <approved> & exact` },
      },
    }));
    const actual = events.map(({ attempt }, index) => ({
      ...attempt.request,
      ...(index === 0 ? { prompt: 'altered old input' } : {}),
    }));
    const history = [
      { id: 'initial', status: 'completed', completedAt: 1, items: [] },
      ...actual.map((request, index) => ({
        id: index === 0 ? 'old-turn' : turn.turnId,
        status: index === 0 ? 'completed' : 'inProgress',
        completedAt: index === 0 ? 2 : null,
        items: [
          {
            type: 'functionCallOutput',
            namespace: 'codex_app',
            name: 'send_message_to_thread',
            output: {
              text: `<codex_delegation>\n    <source_thread_id>intake</source_thread_id>\n    <input>${request.prompt.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</input>\n</codex_delegation>`,
              truncated: false,
            },
          },
        ],
      })),
    ];
    const receipt = codexContinuationNative(async (method, params) => {
      if (params.threadId === 'intake') {
        assert.equal(method, 'thread/items/list');
        const index = events.findIndex((event) => event.attempt.sourceTurnId === params.turnId);
        assert.ok(index >= 0);
        return {
          data: [
            {
              turnId: params.turnId,
              item: {
                id: `send-${index}`,
                type: 'mcpToolCall',
                server: 'codex_app',
                tool: 'send_message_to_thread',
                status: 'completed',
                arguments: actual[index],
              },
            },
          ],
        };
      }
      assert.equal(params.threadId, turn.threadId);
      if (method === 'thread/turns/list')
        return {
          data: history
            .toReversed()
            .slice(0, typeof params.limit === 'number' ? params.limit : undefined),
        };
      assert.equal(method, 'thread/items/list');
      return {
        data: history
          .filter((entry) => entry.id === params.turnId)
          .flatMap((entry) => entry.items.map((item) => ({ turnId: entry.id, item }))),
      };
    });
    assert.equal((await receipt('intake', events[0]!.attempt)).status, 'mismatch');
    const output = await selectCodexTurnTask(
      [{ ...record, threadId: turn.threadId, feedback: { events } } as DispatchRecord],
      turn,
      { ...lookup, receipt },
    );
    assert.equal(output?.feedbackContextRequest?.eventId, 'current');
    assert.equal(output?.feedbackLimitation, undefined);
  });
  it('should retain implementation permission on ordinary resumed turns', async () => {
    const working = {
      ...record,
      threadId: turn.threadId,
      progression: { stage: 'implementation', via: 'work' },
    } as DispatchRecord;
    const output = await selectCodexTurnTask([working], turn, lookup);
    assert.equal(output?.stage, 'implementation');
    assert.equal(output?.contextRuntime, 'continuationRuntime');
  });
});
