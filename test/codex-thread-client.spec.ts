import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

import {
  codexThreadAdapter,
  CodexThreadRpcError,
  type CodexThreadRequest,
} from '../agent/codex-thread-client.ts';

const rejects = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;
const permissions = {
  approvalPolicy: 'on-request',
  approvalsReviewer: 'auto_review',
  sandbox: { type: 'workspaceWrite' },
};
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
    const request: CodexThreadRequest = async (method, params) => {
      calls.push(method);
      if (method === 'model/list')
        return {
          data: [
            { model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
          ],
        };
      if (method === 'thread/start') {
        assert.equal(params.model, 'gpt-6-luna');
        assert.deepEqual(params.config, { model_reasoning_effort: 'medium' });
        assert.equal(params.approvalPolicy, 'on-request');
        assert.equal(params.approvalsReviewer, 'auto_review');
        assert.equal(params.sandbox, 'workspace-write');
      }
      return { ...permissions, ...(method === 'thread/start' ? { thread: { id: 'native' } } : {}) };
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
        { model: 'gpt-6-luna', effort: 'medium' },
      ),
      'native',
    );
    assert.deepEqual(calls, [
      'model/list',
      'thread/start',
      'journal',
      'thread/inject_items',
      'thread/unsubscribe',
      'thread/resume',
      'thread/unsubscribe',
    ]);
    assert.ok(!calls.includes('turn/start'));
  });
  it('should retain the native id and reject ignored or nonpersistent approval settings', async () => {
    for (const stage of ['start', 'resume']) {
      let retained: string | undefined;
      const adapter = codexThreadAdapter(
        async (method) => ({
          ...permissions,
          ...(method === 'thread/' + stage ? { approvalsReviewer: 'user' } : {}),
          thread: { id: 'native' },
        }),
        '/workspace',
      );
      await assert.rejects(
        adapter.create(
          { key: 'binding', phase: 'creating' },
          async (id) => {
            retained = id;
          },
          true,
        ),
        rejects('automation-thread-permissions-diverged'),
      );
      assert.equal(retained, 'native');
    }
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
  it('should expose archival for owned replacement while rejecting wrong-workspace and unavailable targets', async () => {
    const cwd = await realpath('.');
    const archived = {
      id: 'native',
      cwd,
      path: '/archived_sessions/rollout.jsonl',
      canAcceptDirectInput: false,
      status: { type: 'idle' },
    };
    assert.equal(
      (await codexThreadAdapter(async () => ({ thread: archived }), cwd).lookup('native'))
        ?.archived,
      true,
    );
    for (const thread of [
      { ...archived, cwd: '/missing' },
      { ...archived, path: '/sessions/rollout.jsonl' },
    ])
      await assert.rejects(codexThreadAdapter(async () => ({ thread }), cwd).lookup('native'));
  });
  it('should update only model settings under native custody and read through a fresh connection', async () => {
    const cwd = await realpath('.');
    const thread = {
      id: 'native',
      cwd,
      path: '/sessions/fixture',
      status: { type: 'idle' },
      model: 'selected',
      reasoningEffort: 'medium',
    };
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let freshReads = 0;
    const adapter = codexThreadAdapter(
      async (method, params) => {
        calls.push({ method, params });
        if (method === 'model/list')
          return {
            data: [{ model: 'selected', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
          };
        if (method === 'thread/read') return { thread: { ...thread } };
        if (method === 'thread/settings/update') thread.reasoningEffort = String(params.effort);
        return {};
      },
      cwd,
      undefined,
      async () => {
        freshReads++;
        return { thread: { ...thread } };
      },
    );
    const current = (await adapter.lookup('native'))!;
    await adapter.updateSettings!(current, { effort: 'high' });
    assert.deepEqual(calls.find((call) => call.method === 'thread/resume')!.params, {
      threadId: 'native',
    });
    assert.deepEqual(calls.find((call) => call.method === 'thread/settings/update')!.params, {
      threadId: 'native',
      effort: 'high',
    });
    assert.equal((await adapter.lookupFresh!('native'))!.effort, 'high');
    assert.equal(freshReads, 1);
    assert.ok(
      !calls.some((call) =>
        ['turn/start', 'thread/start', 'thread/inject_items'].includes(call.method),
      ),
    );
  });
  it('should report native writer contention without updating or overriding permissions', async () => {
    const calls: string[] = [];
    const adapter = codexThreadAdapter(
      async (method) => {
        calls.push(method);
        if (method === 'model/list')
          return {
            data: [{ model: 'selected', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }],
          };
        throw new CodexThreadRpcError(-32600, 'thread native already has an active writer');
      },
      '/workspace',
      undefined,
      async () => ({}),
    );
    await assert.rejects(
      adapter.updateSettings!({ id: 'native', model: 'selected' }, { effort: 'high' }),
      rejects('automation-thread-settings-busy'),
    );
    assert.deepEqual(calls, ['model/list', 'thread/resume']);
  });
  it('should reject absent catalog models and unsupported efforts before creating a thread', async () => {
    for (const settings of [{ model: 'absent' }, { model: 'selected', effort: 'ultra' }]) {
      const calls: string[] = [];
      const adapter = codexThreadAdapter(async (method) => {
        calls.push(method);
        return {
          data: [{ model: 'selected', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }],
        };
      }, '/workspace');
      await assert.rejects(
        adapter.create({ key: 'fixture', phase: 'creating' }, async () => {}, true, settings),
        rejects(settings.effort ? 'automation-effort-unsupported' : 'automation-model-unsupported'),
      );
      assert.deepEqual(calls, ['model/list']);
    }
  });
});
