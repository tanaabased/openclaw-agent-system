import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

import { AutomationError, type AutomationGateway } from '../agent/automation-gateway.ts';
import automationThreadGateway from '../agent/automation-thread-gateway.ts';

const unavailable = () =>
  new AutomationError('automation-gateway-rejected', {
    method: 'sessions.create',
    category: 'rejected',
    gatewayCode: 'UNAVAILABLE',
    closeCode: null,
    requestDispatched: null,
  });

async function fixture(onCreate: (attempt: number) => void = () => {}) {
  const workspaceDir = await realpath(process.cwd());
  const saved: string[] = [];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const waits: number[] = [];
  let exists = false;
  let creates = 0;
  const request: AutomationGateway = async (method, params) => {
    calls.push({ method, params });
    if (method === 'sessions.resolve')
      return exists ? { ok: true, key: saved[0], agentId: 'fixture' } : { ok: false };
    if (method === 'sessions.list')
      return { sessions: [{ key: saved[0], sessionId: 'native', workspaceDir }] };
    assert.equal(method, 'sessions.create');
    assert.equal(params.key, saved[0], 'the identity must be saved before creation');
    onCreate(++creates);
    exists = true;
    return { ok: true };
  };
  const adapter = automationThreadGateway(
    request,
    { agentId: 'fixture', workspaceDir, scope: 'scope' },
    async (ms) => {
      waits.push(ms);
    },
  );
  return {
    adapter,
    calls,
    waits,
    saved,
    request,
    workspaceDir,
    observeCreated: () => {
      exists = true;
    },
    run: () =>
      adapter.create(
        { key: 'intake', phase: 'creating' },
        async (id) => {
          saved.push(id);
        },
        true,
      ),
  };
}

describe('agent/automation-thread-gateway', () => {
  it('should wait for temporary storage rejection and reuse the same native identity and receipt', async () => {
    const f = await fixture((attempt) => {
      if (attempt < 3) throw unavailable();
    });
    const id = await f.run();
    const creates = f.calls.filter(({ method }) => method === 'sessions.create');
    assert.equal(creates.length, 3);
    assert.deepEqual(f.saved, [id]);
    assert.deepEqual(f.waits, [1000, 2000]);
    assert.deepEqual(creates[0], creates[1]);
    assert.deepEqual(creates[1], creates[2]);
    assert.match(String(creates[0]!.params.idempotencyKey), /^[a-f0-9]{64}$/u);
    assert.equal((await f.adapter.lookup(id))?.id, id);
  });

  it('should adopt a verified session after rejection without creating it again', async () => {
    const f = await fixture(() => {
      f.observeCreated();
      throw unavailable();
    });
    assert.equal(await f.run(), f.saved[0]);
    assert.equal(f.calls.filter(({ method }) => method === 'sessions.create').length, 1);
    assert.deepEqual(f.waits, [1000]);
  });

  it('should preserve the final rejection and stop after bounded readiness retries', async () => {
    const failure = unavailable();
    const f = await fixture(() => {
      throw failure;
    });
    await assert.rejects(f.run(), (error) => error === failure);
    assert.equal(f.calls.filter(({ method }) => method === 'sessions.create').length, 3);
    assert.deepEqual(f.waits, [1000, 2000]);
  });

  it('should not retry lost responses, permission failures, ownership errors or unknown errors', async () => {
    const failures = [
      new AutomationError('automation-gateway-failed', {
        method: 'sessions.create',
        category: 'timeout',
        gatewayCode: null,
        closeCode: null,
        requestDispatched: true,
      }),
      new AutomationError('automation-gateway-unavailable', {
        method: 'sessions.create',
        category: 'timeout',
        gatewayCode: null,
        closeCode: null,
        requestDispatched: false,
      }),
      new AutomationError('automation-gateway-rejected', {
        method: 'sessions.create',
        category: 'rejected',
        gatewayCode: 'FORBIDDEN',
        closeCode: null,
        requestDispatched: null,
      }),
      new AutomationError('automation-thread-owner-mismatch'),
      new Error('unknown'),
    ];
    for (const failure of failures) {
      const f = await fixture(() => {
        throw failure;
      });
      await assert.rejects(f.run(), (error) => error === failure);
      assert.equal(f.calls.filter(({ method }) => method === 'sessions.create').length, 1);
      assert.deepEqual(f.waits, []);
    }
  });

  it('should stop a retry when readback finds another owner or cannot establish absence', async () => {
    for (const mode of ['owner', 'read-failure']) {
      const f = await fixture(() => {
        throw unavailable();
      });
      let waiting = false;
      const readFailure = new Error('read unavailable');
      const adapter = automationThreadGateway(
        async (method, params) => {
          if (waiting) {
            if (mode === 'read-failure') throw readFailure;
            return { ok: true, key: 'other', agentId: 'other' };
          }
          return f.request(method, params);
        },
        { agentId: 'fixture', workspaceDir: f.workspaceDir, scope: 'scope' },
        async () => {
          waiting = true;
        },
      );
      await assert.rejects(
        adapter.create(
          { key: 'intake', phase: 'creating' },
          async (id) => {
            f.saved.push(id);
          },
          true,
        ),
        mode === 'read-failure'
          ? (error) => error === readFailure
          : { code: 'automation-thread-owner-mismatch' },
      );
      assert.equal(f.calls.filter(({ method }) => method === 'sessions.create').length, 1);
    }
  });
});
