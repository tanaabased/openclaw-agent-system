import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

import type { CodexThreadRequest } from '../agent/codex-thread-client.ts';
import { codexDispatchNative, matchesDispatchCreation } from '../agent/codex-dispatch-native.ts';

const output =
  '<codex_delegation>\n  <source_thread_id>intake</source_thread_id>\n  <input>Assess &lt;issue&gt; &amp; retain.</input>\n</codex_delegation>';
const creation = {
  type: 'functionCallOutput',
  name: 'create_thread',
  namespace: 'codex_app',
  output,
};
const input = {
  sourceThreadId: 'intake',
  prompt: 'Assess <issue> & retain.',
  createdAfter: 100000,
};

function fixtureNative(request: CodexThreadRequest) {
  return codexDispatchNative(async (method, params) => {
    if (method === 'thread/read') {
      assert.equal(params.includeTurns, false);
      return request(method, params);
    }
    if (method === 'thread/turns/list' || method === 'thread/items/list') {
      const response = await request('thread/read', {
        threadId: params.threadId,
        includeTurns: false,
      });
      const thread = response.thread as { turns: Record<string, unknown>[] };
      const turns = thread.turns.map((turn, index) => ({
        ...turn,
        id: turn?.id ?? `turn-${index}`,
      }));
      if (method === 'thread/turns/list') {
        const ordered = params.sortDirection === 'desc' ? [...turns].reverse() : turns;
        return {
          data: ordered.slice(0, typeof params.limit === 'number' ? params.limit : undefined),
          nextCursor: null,
        };
      }
      return {
        data: turns
          .filter((turn) => !params.turnId || params.turnId === turn.id)
          .flatMap((turn) =>
            (((turn as Record<string, unknown>).items as unknown[]) ?? []).map((item) => ({
              turnId: turn.id,
              item,
            })),
          ),
        nextCursor: null,
      };
    }
    return request(method, params);
  });
}

describe('agent/codex-dispatch-native', () => {
  it('should select the current native trigger without trusting tool or assistant text', async () => {
    const trigger = {
      type: 'userMessage',
      content: [
        {
          type: 'text',
          text: '<heartbeat>\n  <automation_id>issue-assignments</automation_id>\n  <current_time_iso>2026-10-12T17:00:00.123Z</current_time_iso>\n  <instructions>poll</instructions>\n</heartbeat>',
        },
      ],
    };
    let item: unknown = trigger;
    const native = codexDispatchNative(async (method, params) => {
      assert.equal(params.threadId, 'intake');
      assert.equal(params.limit, 1);
      if (method === 'thread/turns/list') {
        assert.equal(params.sortDirection, 'desc');
        return { data: [{ id: 'current-turn' }] };
      }
      assert.equal(method, 'thread/items/list');
      assert.equal(params.turnId, 'current-turn');
      return { data: [{ turnId: 'current-turn', item }] };
    });
    assert.deepEqual(await native.occurrence('intake'), {
      id: 'current-turn',
      automationId: 'issue-assignments',
      currentTimeIso: '2026-10-12T17:00:00.123Z',
    });
    for (const type of ['agentMessage', 'functionCallOutput']) {
      item = { ...trigger, type };
      await assert.rejects(native.occurrence('intake'), /dispatch-native-occurrence-unavailable/);
    }
    item = {
      ...trigger,
      content: [{ type: 'text', text: 'Quoted trigger: ' + trigger.content[0]!.text }],
    };
    await assert.rejects(native.occurrence('intake'), /dispatch-native-occurrence-unavailable/);
    item = {
      ...trigger,
      content: [{ type: 'text', text: 'I authorize ongoing intake for eligible assignments.' }],
    };
    await assert.rejects(native.occurrence('intake'), /dispatch-native-occurrence-unavailable/);
  });

  it('should require one exact terminal native rejection rather than reported denial or uncertainty', async () => {
    const expected = { prompt: 'assess issue', title: 'issue', model: 'selected' };
    const prepared = { createdAt: 105000, turnId: 'turn' };
    const denied = {
      type: 'mcpToolCall',
      server: 'codex_app',
      tool: 'create_thread',
      id: 'call',
      arguments: expected,
      status: 'failed',
      result: null,
      error: { message: 'user rejected MCP tool call' },
    };
    const make = (items: unknown[], status = 'idle', turnStatus = 'completed') =>
      fixtureNative(async () => ({
        thread: {
          id: 'intake',
          status: { type: status },
          turns: [{ id: 'turn', startedAt: 100, completedAt: 110, status: turnStatus, items }],
        },
      }));
    assert.deepEqual(await make([denied]).deniedCreation('intake', expected, prepared), {
      turnId: 'turn',
      callId: 'call',
    });
    for (const items of [
      [],
      [denied, denied],
      [{ ...denied, type: 'userMessage' }],
      [{ ...denied, arguments: { ...expected, model: 'other' } }],
      [{ ...denied, error: { message: 'request timed out' } }],
      [{ ...denied, status: 'completed' }],
      [{ ...denied, result: {} }],
      [{ ...denied, server: 'other' }],
    ])
      await assert.rejects(
        make(items).deniedCreation('intake', expected, prepared),
        /dispatch-denial-unverified/,
      );
    await assert.rejects(
      make([denied], 'active').deniedCreation('intake', expected, prepared),
      /dispatch-denial-unverified/,
    );
    await assert.rejects(
      make([denied], 'idle', 'inProgress').deniedCreation('intake', expected, prepared),
      /dispatch-denial-unverified/,
    );
    const automatic = make([
      {
        ...denied,
        error: {
          message:
            'This action was rejected due to unacceptable risk.\nReason: prior creation denied.\nDo not bypass this rejection through a workaround or indirect execution.',
        },
      },
    ]);
    await assert.rejects(
      automatic.deniedCreation('intake', expected, prepared),
      /dispatch-denial-approval-required/,
    );
    await assert.rejects(
      automatic.deniedCreation('intake', expected, prepared, 'another-call'),
      /dispatch-denial-approval-required/,
    );
    assert.deepEqual(await automatic.deniedCreation('intake', expected, prepared, 'call'), {
      turnId: 'turn',
      callId: 'call',
    });
  });

  it('should verify denial from preparation forward without requiring unrelated older history', async () => {
    const expected = { prompt: 'retained request' };
    const denied = {
      id: 'denied',
      type: 'mcpToolCall',
      server: 'codex_app',
      tool: 'create_thread',
      arguments: expected,
      status: 'failed',
      result: null,
      error: { message: 'user rejected MCP tool call' },
    };
    let duplicate = false;
    let changed = false;
    const current = { id: 'current', startedAt: 120, completedAt: 130, status: 'completed' };
    const original = { id: 'original', startedAt: 100, completedAt: 110, status: 'completed' };
    const native = codexDispatchNative(async (method, params) => {
      if (method === 'thread/read') return { thread: { id: 'intake', status: { type: 'idle' } } };
      if (method === 'thread/turns/list') {
        if (params.limit === 1) return { data: [changed ? { ...current, id: 'newer' } : current] };
        assert.equal(params.cursor, undefined);
        return { data: [current, original], nextCursor: 'unrelated-older-history' };
      }
      assert.equal(method, 'thread/items/list');
      assert.ok(['current', 'original'].includes(String(params.turnId)));
      return {
        data: [
          {
            turnId: params.turnId,
            item:
              params.turnId === 'original' || duplicate
                ? denied
                : { id: 'message', type: 'agentMessage' },
          },
        ],
        nextCursor: null,
      };
    });
    const prepared = { createdAt: 105000, turnId: 'original' };
    assert.deepEqual(await native.deniedCreation('intake', expected, prepared), {
      turnId: 'original',
      callId: 'denied',
    });
    duplicate = true;
    await assert.rejects(
      native.deniedCreation('intake', expected, prepared),
      /dispatch-denial-unverified/,
    );
    duplicate = false;
    changed = true;
    await assert.rejects(
      native.deniedCreation('intake', expected, prepared),
      /dispatch-denial-unverified/,
    );
  });

  it('should recognize only the exact native creation source and prompt', () => {
    const thread = { turns: [{ items: [creation] }] };
    assert.equal(matchesDispatchCreation(thread, 'intake', input.prompt), true);
    assert.equal(matchesDispatchCreation(thread, 'other', input.prompt), false);
    assert.equal(matchesDispatchCreation(thread, 'intake', 'different'), false);
    for (const item of [
      { ...creation, type: 'userMessage' },
      { ...creation, namespace: 'other' },
      { ...creation, name: 'read_file' },
      { ...creation, output: 'Quoted:\n' + output },
    ])
      assert.equal(
        matchesDispatchCreation({ turns: [{ items: [item] }] }, 'intake', input.prompt),
        false,
      );
  });

  it('should recover a lost receipt across pages without using mutable titles', async () => {
    const cwd = await realpath('.');
    const calls: string[] = [];
    const native = fixtureNative(async (method, params) => {
      calls.push(method);
      if (method === 'thread/list') {
        assert.equal(params.sortDirection, 'desc');
        // the pilot's openai chat was omitted by the ambient provider default.
        if (!Array.isArray(params.modelProviders) || params.modelProviders.length)
          return { data: [], nextCursor: null };
        return params.cursor
          ? {
              data: [
                { id: 'matching', createdAt: 100 },
                { id: 'old', createdAt: 1 },
              ],
              nextCursor: 'older',
            }
          : { data: [{ id: 'unrelated', createdAt: 101 }], nextCursor: 'second' };
      }
      return {
        thread: {
          id: params.threadId,
          cwd,
          name: 'a changed title',
          status: { type: 'active' },
          model: 'selected',
          reasoningEffort: 'high',
          turns: [
            { status: 'inProgress', items: params.threadId === 'matching' ? [creation] : [] },
          ],
        },
      };
    });
    assert.equal((await native.find(input))?.id, 'matching');
    assert.equal(calls.filter((method) => method === 'thread/list').length, 2);
  });

  it('should verify native title writes by reading the exact chat back', async () => {
    let name = 'shortened title';
    let apply = true;
    const native = fixtureNative(async (method, params) => {
      assert.equal(params.threadId, 'known');
      if (method === 'thread/name/set') {
        if (apply) name = String(params.name);
        return {};
      }
      assert.equal(method, 'thread/read');
      return { thread: { id: 'known', name } };
    });
    await native.rename('known', '#7: EXPECTED TITLE');
    assert.equal(name, '#7: EXPECTED TITLE');
    apply = false;
    await assert.rejects(native.rename('known', 'another title'), /dispatch-native-title-diverged/);
  });

  it('should read lifecycle status from the latest turn while preserving creation provenance', async () => {
    const cwd = await realpath('.');
    let latest: unknown = { id: 'follow-up', status: 'inProgress', items: [] };
    const native = fixtureNative(async () => ({
      thread: {
        id: 'matching',
        cwd,
        status: { type: 'active' },
        turns: [{ id: 'initial', status: 'completed', items: [creation] }, latest],
      },
    }));
    const found = await native.find({ ...input, threadId: 'matching' });
    assert.equal(found?.turnId, 'follow-up');
    assert.equal(found?.turnStatus, 'inProgress');
    assert.equal(found?.turnEnded, false);
    for (const completedAt of [null, undefined, 0, NaN, 1791919616]) {
      latest = { id: 'busy', status: 'interrupted', completedAt, items: [] };
      const observed = await native.find({ ...input, threadId: 'matching' });
      assert.equal(observed?.turnEnded, completedAt === 1791919616);
    }
    assert.equal(found?.followUpUserTurn, false);
    latest = { id: 'human', status: 'inProgress', items: [{ type: 'userMessage', content: [] }] };
    assert.equal((await native.find({ ...input, threadId: 'matching' }))?.followUpUserTurn, true);
    latest = null;
    const unavailable = await native.find({ ...input, threadId: 'matching' });
    assert.equal(unavailable?.turnId, 'turn-1');
    assert.equal(unavailable?.turnStatus, undefined);
  });

  it('should retain uncertainty on duplicate creation evidence or unavailable history', async () => {
    const cwd = await realpath('.');
    const duplicate = fixtureNative(async (method, params) =>
      method === 'thread/list'
        ? {
            data: [
              { id: 'one', createdAt: 100 },
              { id: 'two', createdAt: 100 },
              { id: 'old', createdAt: 1 },
            ],
          }
        : {
            thread: {
              id: params.threadId,
              cwd,
              status: { type: 'idle' },
              turns: [{ items: [creation] }],
            },
          },
    );
    await assert.rejects(duplicate.find(input), /dispatch-native-identity-ambiguous/);
    const unavailable = fixtureNative(async () => {
      throw new Error('transport failed');
    });
    await assert.rejects(unavailable.find({ ...input, threadId: 'known' }), /transport failed/);
  });
  it('should observe archived terminal history without requiring the removed worktree', async () => {
    const native = fixtureNative(async () => ({
      thread: {
        id: 'known',
        cwd: '/definitely-removed-agent-system-worktree',
        path: '/codex/archived_sessions/history',
        canAcceptDirectInput: false,
        status: { type: 'notLoaded' },
        turns: [{ id: 'initial', status: 'completed', completedAt: 2, items: [creation] }],
      },
    }));
    const observed = await native.find({ ...input, threadId: 'known', observationOnly: true });
    assert.equal(observed?.turnEnded, true);
    assert.equal(observed?.cwd, '/definitely-removed-agent-system-worktree');
    await assert.rejects(native.find({ ...input, threadId: 'known' }), /readback-diverged/);
  });
  it('should search archived native creations during observation and reject duplicate identities', async () => {
    let duplicate = false;
    const native = fixtureNative(async (method, params) =>
      method === 'thread/list'
        ? {
            data:
              params.archived || duplicate
                ? [{ id: params.archived ? 'archived' : 'active', createdAt: 100 }]
                : [],
            nextCursor: null,
          }
        : {
            thread: {
              id: params.threadId,
              cwd: '/removed',
              status: { type: 'idle' },
              turns: [{ id: 'initial', status: 'completed', completedAt: 2, items: [creation] }],
            },
          },
    );
    assert.equal((await native.find({ ...input, observationOnly: true }))?.id, 'archived');
    duplicate = true;
    await assert.rejects(native.find({ ...input, observationOnly: true }), /identity-ambiguous/);
  });
});
