import assert from 'node:assert/strict';
import dispatchHistory, {
  dispatchHistoryPages,
  nativeHistoryPages,
  dispatchTurn,
} from '../agent/codex-dispatch-history.ts';

describe('agent/codex-dispatch-history', () => {
  it('should read only the relevant send interval while retaining later turns', async () => {
    const loaded: unknown[] = [];
    const turns = await dispatchHistory(
      async (method, params) => {
        if (method === 'thread/turns/list')
          return params.cursor
            ? { data: [{ id: 'before' }, { id: 'unrelated' }], nextCursor: 'older' }
            : { data: [{ id: 'later' }], nextCursor: 'previous' };
        loaded.push(params.turnId);
        return { data: [], nextCursor: null };
      },
      'chat',
      'before',
    );
    assert.deepEqual(
      turns.map((turn) => turn.id),
      ['before', 'later'],
    );
    assert.deepEqual(loaded, ['before', 'later']);
  });
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
  it('should retain uncertainty when the send interval changes during item retrieval', async () => {
    await assert.rejects(
      dispatchHistory(
        async (method, params) => {
          if (method === 'thread/turns/list')
            return { data: [{ id: params.limit === 1 ? 'new-arrival' : 'before' }] };
          return { data: [] };
        },
        'chat',
        'before',
      ),
      /dispatch-native-history-changed/,
    );
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
    let ticks = 0;
    const pages = nativeHistoryPages(
      async () => ({ data: [], nextCursor: 'next' }),
      'thread/items/list',
      {},
      () => ticks++ * 30000,
    );
    await assert.rejects(pages.next(), /dispatch-native-history-incomplete/);
  });
  it('should exhaust more than twenty pages without imposing a message count', async () => {
    let page = 0;
    const entries = await dispatchHistoryPages(
      async (_method, params) => {
        assert.equal(params.limit, undefined);
        page++;
        return { data: [{ id: String(page) }], nextCursor: page < 23 ? String(page) : null };
      },
      'thread/items/list',
      {},
    );
    assert.equal(entries.length, 23);
    assert.equal(entries.at(-1)?.id, '23');
  });

  it('should find known turn metadata and load only that turns complete items', async () => {
    const turn = await dispatchTurn(
      async (method, params) => {
        if (method === 'thread/turns/list') {
          assert.equal(params.itemsView, 'notLoaded');
          return params.cursor
            ? { data: [{ id: 'wanted', status: 'completed' }], nextCursor: null }
            : { data: [{ id: 'unrelated' }], nextCursor: 'older' };
        }
        assert.equal(params.turnId, 'wanted');
        return params.cursor
          ? {
              data: [{ turnId: 'wanted', item: { type: 'commandExecution', status: 'declined' } }],
              nextCursor: null,
            }
          : {
              data: [
                {
                  turnId: 'wanted',
                  item: {
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'x'.repeat(120000) }],
                  },
                },
              ],
              nextCursor: 'more',
            };
      },
      'chat',
      'wanted',
    );
    assert.equal(turn?.items.length, 2);
    assert.equal((turn?.items[1] as { status: string }).status, 'declined');
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
