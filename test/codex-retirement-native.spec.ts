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
