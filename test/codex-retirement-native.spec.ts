import assert from 'node:assert/strict';
import nativeRetirement from '../agent/codex-retirement-native.ts';
import type { CodexThreadRequest } from '../agent/codex-thread-client.ts';

describe('codex retirement native evidence', () => {
  it('should inspect every native page for other users of the worktree', async () => {
    const reader = nativeRetirement(async (method, params) => {
      assert.equal(method, 'thread/list');
      assert.equal(params.archived, false);
      assert.deepEqual(params.modelProviders, []);
      return params.cursor
        ? { data: [{ id: 'other', cwd: '/worktree' }], nextCursor: null }
        : {
            data: [
              { id: 'child', cwd: '/worktree' },
              { id: 'unrelated', cwd: '/elsewhere' },
            ],
            nextCursor: 'page2',
          };
    });
    assert.deepEqual(await reader.worktreeUsers('/worktree'), ['child', 'other']);
  });
  it('should refuse incomplete or malformed native inventories', async () => {
    for (const value of [
      { data: [], nextCursor: 'repeat' },
      { data: [{}], nextCursor: null },
    ]) {
      const reader = nativeRetirement(async () => value);
      await assert.rejects(
        reader.worktreeUsers('/worktree'),
        /retirement-native-inventory-invalid/,
      );
    }
  });
  function helper(id: string, parent = 'owner') {
    return {
      id,
      cwd: '/worktree',
      parentThreadId: parent,
      source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
      status: { type: 'notLoaded' },
    };
  }
  it('should release completed descendants but retain independent owners across inventory pages', async () => {
    const rows = [helper('nested', 'helper'), helper('helper'), helper('independent', 'other')];
    const inspected: string[] = [];
    const reader = nativeRetirement(async (method, params) => {
      if (method === 'thread/list')
        return params.cursor
          ? { data: rows.slice(1), nextCursor: null }
          : { data: [{ id: 'owner', cwd: '/worktree' }, rows[0]], nextCursor: 'next' };
      if (method === 'thread/read') {
        inspected.push(String(params.threadId));
        return { thread: rows.find((row) => row.id === params.threadId) };
      }
      assert.equal(method, 'thread/turns/list');
      assert.equal(params.sortDirection, 'desc');
      assert.equal(params.limit, 1);
      return { data: [{ id: 'done', status: 'completed', completedAt: 10 }] };
    });
    assert.deepEqual(await reader.worktreeUsers('/worktree', new Set(['owner'])), [
      'owner',
      'independent',
    ]);
    assert.deepEqual(inspected, ['nested', 'helper', 'independent']);
  });
  it('should resolve a completed guardian parent from native reads when the list omits it', async () => {
    const reader = nativeRetirement(async (method) => {
      const guardian = {
        id: 'guardian',
        cwd: '/worktree',
        source: { subAgent: { other: 'guardian' } },
      };
      if (method === 'thread/list') return { data: [{ ...guardian, parentThreadId: null }] };
      if (method === 'thread/read')
        return {
          thread: {
            ...guardian,
            parentThreadId: 'owner',
            threadSource: 'guardian_review',
            status: { type: 'notLoaded' },
          },
        };
      return { data: [{ status: 'completed', completedAt: 10 }] };
    });
    assert.deepEqual(await reader.worktreeUsers('/worktree', new Set(['owner'])), []);
    assert.deepEqual(await reader.worktreeUsers('/worktree', new Set(['other'])), ['guardian']);
    assert.deepEqual(
      await reader.worktreeUsers('/worktree', new Set(['owner']), new Set(['guardian'])),
      ['guardian'],
    );
  });
  for (const kind of [
    'active',
    'unfinished',
    'interrupted',
    'missing-turn',
    'missing-time',
    'reparented',
    'moved',
    'fork',
    'protected',
    'unrelated',
    'unknown-source',
  ]) {
    it(`should retain a ${kind} helper as another worktree user`, async () => {
      const row = helper('helper');
      const reader = nativeRetirement(async (method) => {
        if (method === 'thread/list') return { data: [row], nextCursor: null };
        if (method === 'thread/read')
          return {
            thread: {
              ...row,
              ...(kind === 'active' ? { status: { type: 'active' } } : {}),
              ...(kind === 'reparented' ? { parentThreadId: 'other' } : {}),
              ...(kind === 'moved' ? { cwd: '/elsewhere' } : {}),
              ...(kind === 'fork' ? { forkedFromId: 'owner' } : {}),
            },
          };
        return {
          data:
            kind === 'missing-turn'
              ? []
              : [
                  {
                    status:
                      kind === 'unfinished'
                        ? 'inProgress'
                        : kind === 'interrupted'
                          ? 'interrupted'
                          : 'completed',
                    completedAt: kind === 'missing-time' ? null : 10,
                  },
                ],
        };
      });
      if (kind === 'unrelated') row.parentThreadId = 'other';
      if (kind === 'unknown-source') Object.assign(row, { source: 'unknown' });
      assert.deepEqual(
        await reader.worktreeUsers(
          '/worktree',
          new Set(['owner']),
          new Set(kind === 'protected' ? ['helper'] : []),
        ),
        ['helper'],
      );
    });
  }
  it('should propagate unavailable helper evidence instead of permitting cleanup', async () => {
    const reader = nativeRetirement(async (method) => {
      if (method === 'thread/list') return { data: [helper('helper')] };
      throw new Error('native-unavailable');
    });
    await assert.rejects(
      reader.worktreeUsers('/worktree', new Set(['owner'])),
      /native-unavailable/,
    );
  });
  function history(item?: Record<string, unknown>): CodexThreadRequest {
    const message = { id: 'message', type: 'agentMessage', text: 'archive completed' };
    return async (method, params) => {
      if (method === 'thread/turns/list')
        return {
          data: [
            { id: 'current', startedAt: 120, status: 'inProgress', completedAt: null },
            { id: 'prepared', startedAt: 100, status: 'completed', completedAt: 110 },
          ].slice(0, Number(params.limit)),
          nextCursor: null,
        };
      return {
        data: (params.turnId === 'current' || !item ? [message] : [message, item]).map((item) => ({
          turnId: params.turnId,
          item,
        })),
        nextCursor: null,
      };
    };
  }
  it('should prove non-submission from completed native history without trusting prose', async () => {
    assert.equal(
      await nativeRetirement(history()).archiveOutcome(
        'owner',
        'child',
        { at: 105000, turnId: 'prepared' },
        'current',
      ),
      'unsubmitted',
    );
  });
  it('should keep missing and unreadable archive arguments unresolved', async () => {
    for (const args of [undefined, {}, { archived: true }]) {
      const call = {
        id: 'call',
        type: 'mcpToolCall',
        server: 'codex_app',
        tool: 'set_thread_archived',
        arguments: args,
        status: 'completed',
      };
      assert.equal(
        await nativeRetirement(history(call)).archiveOutcome(
          'owner',
          'child',
          { at: 105000, turnId: 'prepared' },
          'current',
        ),
        'unverified',
      );
    }
  });
  for (const message of [
    'user rejected MCP tool call',
    'This action was rejected due to unacceptable risk.\nReason: test. Do not bypass this rejection through a workaround or indirect execution.',
  ]) {
    it('should identify the exact native archive approval denial', async () => {
      const call = {
        id: 'denied-call',
        type: 'mcpToolCall',
        server: 'codex_app',
        tool: 'set_thread_archived',
        arguments: { threadId: 'child', archived: true, hostId: 'local' },
        status: 'failed',
        result: null,
        error: { message },
      };
      const outcome = (item: Record<string, unknown>) =>
        nativeRetirement(history(item)).archiveOutcome(
          'owner',
          'child',
          { at: 105000, turnId: 'prepared' },
          'current',
        );
      assert.equal(await outcome(call), 'denied');
      assert.equal(await outcome({ ...call, error: { message: 'connection lost' } }), 'unverified');
      assert.equal(await outcome({ ...call, server: 'unrelated' }), 'unverified');
      assert.equal(await outcome({ ...call, result: {} }), 'unverified');
      assert.equal(
        await outcome({ ...call, arguments: { threadId: 'other', archived: true } }),
        'unsubmitted',
      );
    });
  }
  for (const status of ['completed', 'failed', 'inProgress']) {
    it(`should never repeat an archive with ${status} native evidence`, async () => {
      const call = {
        id: 'call',
        type: 'mcpToolCall',
        server: 'codex_app',
        tool: 'set_thread_archived',
        arguments: { threadId: 'child', archived: true },
        status,
      };
      assert.equal(
        await nativeRetirement(history(call)).archiveOutcome(
          'owner',
          'child',
          { at: 105000, turnId: 'prepared' },
          'current',
        ),
        'unverified',
      );
    });
  }
});
