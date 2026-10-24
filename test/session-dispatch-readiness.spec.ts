import assert from 'node:assert/strict';

import waitForSessionDispatchGateway from '../credentials/session-dispatch-readiness.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';

function fixture(
  response: (path: string, now: number) => { statusCode: number; body: unknown },
  authority: DispatchAuthority = {},
) {
  let now = 0;
  const calls: { path: string; timeoutMs: number; at: number }[] = [];
  const controller = new AbortController();
  return {
    calls,
    controller,
    now: () => now,
    run: () =>
      waitForSessionDispatchGateway(
        23456,
        authority,
        { maxWaitMs: 30_000, signal: controller.signal },
        {
          now: () => now,
          async sleep(ms, signal) {
            signal?.throwIfAborted();
            now += ms;
          },
          async request(port, path, timeoutMs, signal) {
            assert.equal(port, 23456);
            assert.equal(signal, controller.signal);
            assert.ok(timeoutMs > 0 && timeoutMs <= 2_000 && timeoutMs <= 30_000 - now);
            calls.push({ path, timeoutMs, at: now });
            return response(path, now);
          },
        },
      ),
  };
}

const started = { statusCode: 200, body: { ok: true, status: 'started' } };
const ready = { statusCode: 200, body: { ready: true, failing: [] } };
const loading = (phase = 'reloading') => ({
  statusCode: 503,
  body: {
    ready: false,
    failing: ['plugin-reload'],
    pluginReload: { phase, reason: 'private-token' },
  },
});

describe('credentials/session-dispatch-readiness', () => {
  it('should wait through gateway startup and plugin replacement before starting authentication', async () => {
    const f = fixture((path, now) => {
      if (path === '/startupz')
        return now < 500 ? { statusCode: 503, body: { ok: false, status: 'starting' } } : started;
      return now < 11_500 ? loading(now < 10_000 ? 'reloading' : 'recovering') : ready;
    });
    assert.equal((await f.run()).ready, true);
    assert.equal(f.now(), 11_500);
    assert.equal(f.calls.at(-1)?.path, '/readyz');
  });

  it('should not make unrelated channel or database health an enrollment prerequisite', async () => {
    for (const failing of [['telegram'], ['agent-database:other'], ['agent-system-github']]) {
      const f = fixture((path) =>
        path === '/startupz' ? started : { statusCode: 503, body: { ready: false, failing } },
      );
      assert.equal((await f.run()).ready, true);
      assert.equal(f.now(), 0);
    }
  });

  it('should bound unavailable, draining and permanently reloading gateways without resetting the deadline', async () => {
    for (const state of ['unavailable', 'draining', 'reloading']) {
      const f = fixture((path) => {
        if (state === 'unavailable') throw new Error('private-token');
        if (path === '/startupz')
          return state === 'draining'
            ? { statusCode: 503, body: { ok: false, status: 'draining' } }
            : started;
        return loading();
      });
      await assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
        assert.deepEqual(error.sessionDispatchDiagnostic, {
          category: 'timeout',
          phase: 'connection',
          reasonCode: 'gateway-readiness-deadline',
        });
        assert.ok(!JSON.stringify(error).includes('private-token'));
        return true;
      });
      assert.equal(f.now(), 30_000);
      assert.ok(f.calls.every((call) => call.at < 30_000));
    }
  });

  it('should stop on terminal plugin replacement failure without exposing its reason', async () => {
    const f = fixture((path) => (path === '/startupz' ? started : loading('failed')));
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
      assert.deepEqual(error.sessionDispatchDiagnostic, {
        category: 'gateway-rejected',
        phase: 'connection',
        reasonCode: 'gateway-reload-failed',
      });
      assert.ok(!JSON.stringify(error).includes('private-token'));
      return true;
    });
    assert.equal(f.now(), 0);
  });

  it('should leave unsupported or malformed probes to the mandatory authenticated handshake', async () => {
    for (const probe of [
      { statusCode: 404, body: undefined },
      { statusCode: 302, body: {} },
      { statusCode: 200, body: 'private-token' },
      { statusCode: 503, body: { ready: false } },
    ]) {
      const f = fixture(() => probe);
      assert.equal((await f.run()).ready, true);
      assert.equal(f.now(), 0);
    }
  });

  it('should preserve cancellation and authority loss after a successful or failed probe', async () => {
    for (const remoteFails of [false, true]) {
      for (const cancelled of [false, true]) {
        let changed = false;
        const failure = new Error('authority-lost');
        const f = fixture(
          () => {
            changed = true;
            if (cancelled) f.controller.abort(failure);
            if (remoteFails) throw new Error('private-token');
            return started;
          },
          {
            assertEnrollmentCurrent() {
              if (changed && !cancelled) throw failure;
            },
          },
        );
        await assert.rejects(f.run(), (error: unknown) => error === failure);
        assert.equal(f.calls.length, 1);
      }
    }
  });
});
