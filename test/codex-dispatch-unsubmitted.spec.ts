import assert from 'node:assert/strict';

import unsubmittedCreation from '../agent/codex-dispatch-unsubmitted.ts';
import type { CodexThreadRequest } from '../agent/codex-thread-client.ts';

describe('agent/codex-dispatch-unsubmitted', () => {
  const oldTurn = { id: 'prepared', startedAt: 100, completedAt: 110, status: 'completed' };
  const current = { id: 'current', startedAt: 120, completedAt: null, status: 'inProgress' };
  const message = { id: 'message', type: 'agentMessage', text: 'no chat was created' };
  const command = { id: 'command', type: 'commandExecution', status: 'completed' };
  function fixture(
    items: Record<string, unknown>[] = [command, message],
    turns: Record<string, unknown>[] = [current, oldTurn],
  ): CodexThreadRequest {
    return async (method, params) => {
      assert.equal(params.threadId, 'intake');
      if (method === 'thread/turns/list')
        return {
          data: turns.slice(0, typeof params.limit === 'number' ? params.limit : undefined),
          nextCursor: null,
        };
      assert.equal(method, 'thread/items/list');
      return {
        data: (params.turnId === 'current' ? [message] : items).map((item) => ({
          turnId: params.turnId,
          item,
        })),
        nextCursor: null,
      };
    };
  }
  const prove = (request = fixture(), turnId: string | undefined = 'prepared') =>
    unsubmittedCreation(
      request,
      'intake',
      { createdAt: 105500, turnId, prompt: 'retained request' },
      'current',
    );

  it('should prove a completed preparation without trusting assistant prose', async () => {
    assert.deepEqual(await prove(), { turnId: 'prepared' });
    assert.deepEqual(await prove(fixture([command, { ...message, text: 'a chat exists' }])), {
      turnId: 'prepared',
    });
    assert.deepEqual(
      await unsubmittedCreation(fixture(), 'intake', { createdAt: 105500 }, 'current'),
      { turnId: 'prepared' },
    );
  });

  it('should refuse matching calls, denials, and unrecognized history items', async () => {
    for (const item of [
      { type: 'mcpToolCall', server: 'codex_app', tool: 'create_thread', status: 'completed' },
      { type: 'mcpToolCall', server: 'codex_app', tool: 'create_thread', status: 'failed' },
      { type: 'functionCall', name: 'create_thread' },
      { type: 'unknown' },
      { type: 'mcpToolCall', server: 'codex_app', tool: 'list_projects', status: 'inProgress' },
      { type: 'commandExecution', status: 'inProgress' },
    ])
      assert.equal(await prove(fixture([message, { id: 'uncertain', ...item }])), undefined);
  });

  it('should distinguish unrelated terminal failures and native markers from creation evidence', async () => {
    const items = [
      { id: 'failed-command', type: 'commandExecution', status: 'failed', exitCode: 1 },
      { id: 'declined-command', type: 'commandExecution', status: 'declined' },
      { id: 'compaction', type: 'contextCompaction' },
      { id: 'sleep', type: 'sleep' },
      { id: 'search', type: 'webSearch' },
      {
        id: 'unrelated-tool',
        type: 'mcpToolCall',
        server: 'codex_app',
        tool: 'list_projects',
        status: 'failed',
      },
    ];
    assert.deepEqual(await prove(fixture(items)), { turnId: 'prepared' });
    for (const status of ['completed', 'failed']) {
      const call = {
        id: 'creation',
        type: 'mcpToolCall',
        server: 'codex_app',
        tool: 'create_thread',
        status,
      };
      assert.deepEqual(
        await prove(
          fixture([...items, { ...call, arguments: { prompt: 'another retained request' } }]),
        ),
        { turnId: 'prepared' },
      );
      for (const args of [undefined, {}, { prompt: '' }, { prompt: 'retained request' }])
        assert.equal(await prove(fixture([...items, { ...call, arguments: args }])), undefined);
    }
  });

  it('should reject unfinished, missing, mismatched, and ambiguous preparation turns', async () => {
    for (const turns of [
      [current],
      [current, { ...oldTurn, status: 'inProgress' }],
      [current, { ...oldTurn, status: 'failed' }],
      [current, { ...oldTurn, completedAt: 104 }],
      [current, { ...oldTurn, completedAt: null }],
      [current, { ...oldTurn, completedAt: 125 }],
      [current, { ...oldTurn, startedAt: 130 }],
      [current, current, oldTurn],
      [oldTurn],
    ])
      assert.equal(await prove(fixture([command], turns)), undefined);
    assert.equal(await prove(fixture(), 'other-turn'), undefined);
    assert.equal(await prove(fixture([])), undefined);
    assert.equal(await prove(fixture([command, command])), undefined);
  });

  it('should inspect later completed turns and refuse intervening creation', async () => {
    const turns = [
      current,
      { ...oldTurn, id: 'intervening', startedAt: 112, completedAt: 115 },
      oldTurn,
    ];
    const base = fixture([command], turns);
    assert.deepEqual(await prove(base), { turnId: 'prepared' });
    assert.equal(
      await prove(async (method, params) => {
        if (method === 'thread/items/list' && params.turnId === 'intervening')
          return {
            data: [
              {
                turnId: 'intervening',
                item: {
                  id: 'call',
                  type: 'mcpToolCall',
                  server: 'codex_app',
                  tool: 'create_thread',
                  status: 'completed',
                },
              },
            ],
            nextCursor: null,
          };
        return base(method, params);
      }),
      undefined,
    );
  });

  it('should consume complete item pages and stop on missing or changing history', async () => {
    const base = fixture();
    const paged: CodexThreadRequest = async (method, params) => {
      if (method === 'thread/items/list' && params.turnId === 'prepared') {
        if (!params.cursor)
          return { data: [{ turnId: 'prepared', item: message }], nextCursor: 'page-2' };
        return {
          data: [
            {
              turnId: 'prepared',
              item: {
                id: 'call',
                type: 'mcpToolCall',
                tool: 'create_thread',
                server: 'codex_app',
                status: 'completed',
              },
            },
          ],
          nextCursor: null,
        };
      }
      return base(method, params);
    };
    assert.equal(await prove(paged), undefined);
    await assert.rejects(
      prove(async (method, params) => {
        if (method === 'thread/items/list') return { data: [], nextCursor: 'same' };
        return base(method, params);
      }),
      /dispatch-native-response-invalid/,
    );
    assert.equal(
      await prove(async (method, params) => {
        if (method === 'thread/turns/list' && params.limit === 1)
          return { data: [{ id: 'new-turn' }] };
        return base(method, params);
      }),
      undefined,
    );
  });

  it('should follow bounded turn pages without requiring older unrelated history', async () => {
    const base = fixture();
    assert.deepEqual(
      await prove(async (method, params) => {
        if (method === 'thread/turns/list' && params.limit !== 1)
          return params.cursor
            ? { data: [oldTurn], nextCursor: 'older-history' }
            : { data: [current], nextCursor: 'preparation-page' };
        return base(method, params);
      }),
      { turnId: 'prepared' },
    );
    assert.equal(
      await prove(async (method, params) => {
        if (method === 'thread/turns/list' && params.limit !== 1)
          return { data: [current], nextCursor: 'repeated' };
        return base(method, params);
      }),
      undefined,
    );
  });
});
