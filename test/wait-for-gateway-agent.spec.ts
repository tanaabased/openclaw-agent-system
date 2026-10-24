import assert from 'node:assert/strict';

import waitForGatewayAgent from '../agent/wait-for-gateway-agent.ts';

const snapshot = {
  valid: true,
  hash: 'saved-revision',
  configRevisionHash: 'new',
  appliedConfigHash: 'old',
  config: { agents: { entries: { data: { workspace: '/workspace/data' } } } },
};

function fixture(respond: (method: string, params: Record<string, unknown>) => unknown) {
  let now = 0;
  const calls: string[] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    run: () =>
      waitForGatewayAgent(
        'data',
        { info: (text) => logs.push(text), debug: () => {} },
        {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          request: async (method, params) => {
            calls.push(method);
            return respond(method, params);
          },
        },
      ),
  };
}

describe('agent/wait-for-gateway-agent', () => {
  it('should reapply an unapplied saved revision once and verify native visibility', async () => {
    let applied = false;
    const test = fixture((method, params) => {
      if (method === 'config.get') return snapshot;
      if (method === 'config.apply') {
        assert.deepEqual(params, { baseHash: snapshot.hash, raw: JSON.stringify(snapshot.config) });
        applied = true;
        return { ok: true };
      }
      return { agents: applied ? [{ id: 'data' }] : [{ id: 'main' }] };
    });
    await test.run();
    assert.deepEqual(test.calls, ['agents.list', 'config.get', 'config.apply', 'agents.list']);
  });

  it('should avoid config reads or writes when registration is already visible', async () => {
    const test = fixture(() => ({ agents: [{ id: 'data' }] }));
    await test.run();
    assert.deepEqual(test.calls, ['agents.list']);
  });

  it('should never count an apply acknowledgment as agent visibility or repeat the write', async () => {
    const test = fixture((method) =>
      method === 'config.get'
        ? snapshot
        : method === 'config.apply'
          ? { ok: true }
          : { agents: [] },
    );
    await assert.rejects(test.run(), { code: 'agent-gateway-registration-pending' });
    assert.equal(test.calls.filter((method) => method === 'config.apply').length, 1);
  });

  it('should preserve disabled reload and avoid reapplying unverified or already applied snapshots', async () => {
    for (const config of [
      null,
      {},
      { ...snapshot, valid: false },
      { ...snapshot, hash: '' },
      { ...snapshot, config: {} },
      { ...snapshot, appliedConfigHash: 'new' },
      { ...snapshot, config: { ...snapshot.config, gateway: { reload: { mode: 'off' } } } },
    ]) {
      const test = fixture((method) => (method === 'config.get' ? config : { agents: [] }));
      await assert.rejects(test.run(), { code: 'agent-gateway-registration-pending' });
      assert.equal(test.calls.includes('config.apply'), false);
    }
  });

  it('should stop on rejected or uncertain application without exposing raw errors or replaying', async () => {
    for (const error of [
      new Error('secret conflict or denial'),
      Object.assign(new Error('secret timeout'), {
        name: 'GatewayTransportError',
        connectionDetails: {},
        kind: 'timeout',
        requestDispatched: true,
      }),
    ]) {
      const test = fixture((method) => {
        if (method === 'config.get') return snapshot;
        if (method === 'config.apply') throw error;
        return { agents: [] };
      });
      await assert.rejects(test.run(), (failure: Error & { code?: string }) => {
        assert.equal(failure.code, 'agent-gateway-verification-failed');
        assert.doesNotMatch(failure.message, /secret/u);
        return true;
      });
      assert.equal(test.calls.filter((method) => method === 'config.apply').length, 1);
      assert.doesNotMatch(test.logs.join('\n'), /secret/u);
    }
  });

  it('should preserve offline installation when the first request cannot reach the gateway', async () => {
    const test = fixture(() => {
      throw Object.assign(new Error('secret socket'), {
        name: 'GatewayTransportError',
        connectionDetails: {},
        kind: 'closed',
      });
    });
    await test.run();
    assert.deepEqual(test.calls, ['agents.list']);
  });

  it('should not submit a write with only a fractional deadline remaining', async () => {
    let now = 0;
    const calls: string[] = [];
    await assert.rejects(
      waitForGatewayAgent('data', undefined, {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        request: async (method) => {
          calls.push(method);
          if (method === 'config.get') {
            now = 29_999;
            return snapshot;
          }
          return { agents: [] };
        },
      }),
      { code: 'agent-gateway-registration-pending' },
    );
    assert.deepEqual(calls, ['agents.list', 'config.get']);
  });
});

describe('agent registration read budgets', () => {
  it('should observe through a slow transient read using only the remaining total budget', async () => {
    let now = 0;
    const budgets: number[] = [];
    await waitForGatewayAgent('data', undefined, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      request: async (method, _params, timeout) => {
        assert.equal(method, 'agents.list');
        budgets.push(timeout);
        if (budgets.length === 1) {
          now += 12_000;
          throw Object.assign(new Error('private timeout'), {
            name: 'GatewayTransportError',
            connectionDetails: {},
            kind: 'timeout',
            requestDispatched: true,
          });
        }
        return { agents: [{ id: 'data' }] };
      },
    });
    assert.deepEqual(budgets, [30_000, 17_000]);
  });

  it('should exhaust transient read observations without config writes or renewed budgets', async () => {
    let now = 0;
    let requests = 0;
    await assert.rejects(
      waitForGatewayAgent('data', undefined, {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        request: async (method, _params, timeout) => {
          assert.equal(method, 'agents.list');
          assert.ok(timeout <= 30_000 - now);
          requests++;
          now += Math.min(7_000, timeout);
          throw Object.assign(new Error('private reset'), {
            name: 'GatewayTransportError',
            connectionDetails: {},
            kind: 'closed',
            code: 1006,
            requestDispatched: true,
          });
        },
      }),
      { code: 'agent-gateway-registration-pending' },
    );
    assert.equal(now, 30_000);
    assert.ok(requests > 1);
  });

  it('should stop on an explicit refusal without treating it as a transient read', async () => {
    let calls = 0;
    await assert.rejects(
      waitForGatewayAgent('data', undefined, {
        now: () => 0,
        sleep: async () => {
          assert.fail('refusal must not retry');
        },
        request: async () => {
          calls++;
          throw new Error('permission denied');
        },
      }),
      { code: 'agent-gateway-verification-failed' },
    );
    assert.equal(calls, 1);
  });
});
