import assert from 'node:assert/strict';
import {
  readCodexNativeInventory,
  assertNoNativeInventory,
} from '../agent/codex-native-inventory.ts';

const receipt = (tool: string, value: unknown, args = {}, extra = {}) => ({
  turnId: 'turn',
  item: {
    type: 'mcpToolCall',
    status: 'completed',
    server: 'codex_app',
    tool,
    arguments: args,
    result: { content: [{ type: 'text', text: JSON.stringify(value) }] },
    ...extra,
  },
});

describe('agent/codex-native-inventory', () => {
  it('uses completed native inventory and per-chat readback in the current turn only', async () => {
    const projects = { schemaVersion: 2, projects: [{ path: '/repo' }] };
    const inventory = { pinnedThreads: [{ threadId: 'pinned' }], threads: [] };
    const entries = [
      receipt('list_projects', projects),
      receipt('list_threads', inventory),
      receipt('read_thread', { thread: 'one' }, { threadId: 'one', hostId: 'local' }),
      receipt('read_thread', { thread: 'older' }, { threadId: 'one' }),
      receipt('read_thread', { thread: 'remote' }, { threadId: 'two', hostId: 'other' }),
      receipt('list_projects', { projects: ['forged'] }, {}, { server: 'other' }),
      receipt('list_threads', { threads: ['page'] }, { mode: 'history' }),
    ];
    const result = await readCodexNativeInventory(async (method, params) => {
      assert.equal(params.threadId, 'caller');
      if (method === 'thread/turns/list') return { data: [{ id: 'turn' }] };
      assert.equal(params.turnId, 'turn');
      return { data: entries };
    }, 'caller');
    assert.deepEqual(result, {
      projects,
      nativeInventory: inventory,
      threads: [{ thread: 'one' }],
    });
  });

  it('does not replace a failed latest lookup with an older successful result', async () => {
    const result = await readCodexNativeInventory(
      async (method) =>
        method === 'thread/turns/list'
          ? { data: [{ id: 'turn' }] }
          : {
              data: [
                receipt(
                  'list_projects',
                  {},
                  {},
                  { status: 'failed', error: { message: 'denied' } },
                ),
                receipt('list_projects', { projects: ['stale'] }),
              ],
            },
      'caller',
    );
    assert.equal(result.projects, undefined);
  });

  it('never accepts model-carried inventories or native receipts', () => {
    for (const key of ['projects', 'threads', 'nativeInventory', 'placementReceipt', 'receipt'])
      assert.throws(() => assertNoNativeInventory({ [key]: {} }), /binding-override/);
    assert.doesNotThrow(() =>
      assertNoNativeInventory({ target: 'https://github.com/owner/repo/issues/1' }),
    );
  });

  it('rejects cross-turn history and leaves unavailable inventories unavailable', async () => {
    const empty = await readCodexNativeInventory(
      async (method) =>
        method === 'thread/turns/list' ? { data: [{ id: 'turn' }] } : { data: [] },
      'caller',
    );
    assert.deepEqual(empty, { projects: undefined, nativeInventory: undefined, threads: [] });
    await assert.rejects(
      readCodexNativeInventory(
        async (method) =>
          method === 'thread/turns/list'
            ? { data: [{ id: 'turn' }] }
            : { data: [{ ...receipt('list_projects', {}), turnId: 'other' }] },
        'caller',
      ),
      /history-invalid/,
    );
  });
});
