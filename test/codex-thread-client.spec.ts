import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

import {
  codexThreadAdapter,
  CodexThreadRpcError,
  type CodexThreadRequest,
} from '../agent/codex-thread-client.ts';

const rejects = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;
describe('agent/codex-thread-client', () => {
  it('should distinguish native absence from permission and transport failures', async () => {
    for (const [error, absent] of [
      [new CodexThreadRpcError(-32600, 'no rollout found for thread id activity'), true],
      [new CodexThreadRpcError(-32600, 'invalid thread id: invalid character'), true],
      [new CodexThreadRpcError(-32600, 'permission denied'), false],
      [new Error('timeout'), false],
    ] as const) {
      const adapter = codexThreadAdapter(async () => {
        throw error;
      }, '/workspace');
      if (absent) assert.equal(await adapter.lookup('activity'), null);
      else
        await assert.rejects(
          adapter.lookup('activity'),
          rejects('automation-thread-lookup-failed'),
        );
    }
  });
  it('should journal the id before non-generating materialization and resume verification', async () => {
    const calls: string[] = [];
    const request: CodexThreadRequest = async (method) => {
      calls.push(method);
      return method === 'thread/start' ? { thread: { id: 'native' } } : {};
    };
    const adapter = codexThreadAdapter(request, '/workspace');
    assert.equal(
      await adapter.create(
        { key: 'binding', phase: 'creating' },
        async (id) => {
          assert.equal(id, 'native');
          calls.push('journal');
        },
        true,
      ),
      'native',
    );
    assert.deepEqual(calls, [
      'thread/start',
      'journal',
      'thread/inject_items',
      'thread/unsubscribe',
      'thread/resume',
    ]);
    assert.ok(!calls.includes('turn/start'));
  });
  it('should never repeat an ambiguous create or replace a known failed target', async () => {
    let calls = 0;
    const adapter = codexThreadAdapter(async () => {
      calls++;
      throw new Error('missing known thread');
    }, '/workspace');
    await assert.rejects(
      adapter.create({ key: 'binding', phase: 'creating' }, async () => {}, false),
      rejects('automation-thread-create-ambiguous'),
    );
    assert.equal(calls, 0);
    await assert.rejects(
      adapter.create(
        { key: 'binding', nativeId: 'known', phase: 'materializing' },
        async () => {},
        false,
      ),
      /missing known thread/,
    );
    assert.equal(calls, 1);
  });
  it('should reject archived and wrong-workspace native targets', async () => {
    const cwd = await realpath('.');
    for (const thread of [
      { id: 'native', cwd: '/missing', path: '/sessions/rollout.jsonl', status: { type: 'idle' } },
      { id: 'native', cwd, path: '/archived_sessions/rollout.jsonl', status: { type: 'idle' } },
    ]) {
      await assert.rejects(codexThreadAdapter(async () => ({ thread }), cwd).lookup('native'));
    }
  });
});
