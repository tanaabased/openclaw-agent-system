import assert from 'node:assert/strict';
import dispatchHistory, { dispatchHistoryPages } from '../agent/codex-dispatch-history.ts';

describe('agent/codex-dispatch-history', () => {
  it('should read only edge turns and page their items without loading the full chat', async () => {
    const turns = await dispatchHistory(async (method, params) => {
      assert.notEqual(method, 'thread/read');
      if (method === 'thread/turns/list') {
        assert.equal(params.itemsView, 'notLoaded');
        assert.equal(params.limit, 1);
        return {
          data: [{ id: params.sortDirection === 'asc' ? 'first' : 'last', status: 'completed' }],
        };
      }
      return params.cursor
        ? { data: [{ turnId: params.turnId, item: { type: 'userMessage' } }], nextCursor: null }
        : { data: [], nextCursor: 'next' };
    }, 'chat');
    assert.deepEqual(
      turns.map((turn) => turn.id),
      ['first', 'last'],
    );
    assert.deepEqual(turns[1]!.items, [{ type: 'userMessage' }]);
  });
  it('should fail closed on malformed, cyclic, or truncated pagination', async () => {
    for (const data of [null, [null], ['prose']])
      await assert.rejects(
        dispatchHistoryPages(async () => ({ data }), 'thread/items/list', {}),
        /dispatch-native-response-invalid/,
      );
    await assert.rejects(
      dispatchHistoryPages(
        async () => ({ data: [], nextCursor: 'repeat' }),
        'thread/items/list',
        {},
      ),
      /dispatch-native-response-invalid/,
    );
    let page = 0;
    await assert.rejects(
      dispatchHistoryPages(
        async () => ({ data: [], nextCursor: String(++page) }),
        'thread/items/list',
        {},
      ),
      /dispatch-native-history-incomplete/,
    );
    assert.equal(page, 20);
  });
  it('should reject item pages that refer to a turn absent from the metadata snapshot', async () => {
    await assert.rejects(
      dispatchHistory(
        async (method) =>
          method === 'thread/turns/list'
            ? { data: [{ id: 'old', status: 'completed' }], nextCursor: null }
            : { data: [{ turnId: 'new', item: { type: 'mcpToolCall' } }], nextCursor: null },
        'chat',
        true,
      ),
      /dispatch-native-history-changed/,
    );
  });
});
