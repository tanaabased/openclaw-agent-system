import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

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

describe('agent/codex-dispatch-native', () => {
  it('should require one exact terminal native rejection rather than reported denial or uncertainty', async () => {
    const expected = { prompt: 'assess issue', title: 'issue', model: 'selected' };
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
      codexDispatchNative(async () => ({
        thread: {
          id: 'intake',
          status: { type: status },
          turns: [{ id: 'turn', status: turnStatus, items }],
        },
      }));
    assert.deepEqual(await make([denied]).deniedCreation('intake', expected), {
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
        make(items).deniedCreation('intake', expected),
        /dispatch-denial-unverified/,
      );
    await assert.rejects(
      make([denied], 'active').deniedCreation('intake', expected),
      /dispatch-denial-unverified/,
    );
    await assert.rejects(
      make([denied], 'idle', 'inProgress').deniedCreation('intake', expected),
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
      automatic.deniedCreation('intake', expected),
      /dispatch-denial-approval-required/,
    );
    await assert.rejects(
      automatic.deniedCreation('intake', expected, 'another-call'),
      /dispatch-denial-approval-required/,
    );
    assert.deepEqual(await automatic.deniedCreation('intake', expected, 'call'), {
      turnId: 'turn',
      callId: 'call',
    });
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
    const native = codexDispatchNative(async (method, params) => {
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
    assert.deepEqual(calls, ['thread/list', 'thread/read', 'thread/list', 'thread/read']);
  });

  it('should verify native title writes by reading the exact chat back', async () => {
    let name = 'shortened title';
    let apply = true;
    const native = codexDispatchNative(async (method, params) => {
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
    const native = codexDispatchNative(async () => ({
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
    latest = null;
    const unavailable = await native.find({ ...input, threadId: 'matching' });
    assert.equal(unavailable?.turnId, undefined);
    assert.equal(unavailable?.turnStatus, undefined);
  });

  it('should retain uncertainty on duplicate creation evidence or unavailable history', async () => {
    const cwd = await realpath('.');
    const duplicate = codexDispatchNative(async (method, params) =>
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
    const unavailable = codexDispatchNative(async () => {
      throw new Error('transport failed');
    });
    await assert.rejects(unavailable.find({ ...input, threadId: 'known' }), /transport failed/);
  });
});
