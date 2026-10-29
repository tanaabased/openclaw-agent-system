import assert from 'node:assert/strict';

import { SessionDispatchConnectionError } from '../credentials/session-dispatch-diagnostic.ts';
import {
  readinessObservationLimit,
  type ReadinessEvidence,
} from '../credentials/session-dispatch-readiness-evidence.ts';
import waitForSessionDispatchGateway from '../credentials/session-dispatch-readiness.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';

function fixture(
  response: (
    path: string,
    now: number,
  ) => { statusCode: number; body: unknown; malformed?: boolean },
  authority: DispatchAuthority = {},
  maxWaitMs = 90_000,
  requestElapsedMs = 0,
) {
  let now = 0;
  const calls: { path: string; timeoutMs: number; at: number }[] = [];
  const controller = new AbortController();
  const sleeps: number[] = [];
  let evidence: ReadinessEvidence | undefined;
  return {
    calls,
    sleeps,
    evidence: () => evidence,
    controller,
    now: () => now,
    run: () =>
      waitForSessionDispatchGateway(
        23456,
        authority,
        {
          maxWaitMs,
          signal: controller.signal,
          onEvidence: (value) => {
            evidence = value;
          },
        },
        {
          now: () => now,
          async sleep(ms, signal) {
            signal?.throwIfAborted();
            sleeps.push(ms);
            now += ms;
          },
          async request(port, path, timeoutMs, signal) {
            assert.equal(port, 23456);
            assert.equal(signal, controller.signal);
            assert.ok(timeoutMs > 0 && timeoutMs <= 2_000 && timeoutMs <= maxWaitMs - now);
            calls.push({ path, timeoutMs, at: now });
            try {
              return response(path, now);
            } finally {
              now += requestElapsedMs;
            }
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
  it('should finish a cold reload beyond the old budget without restarting its deadline', async () => {
    const f = fixture((path, now) =>
      path === '/startupz'
        ? started
        : now < 45_000
          ? loading(now < 30_000 ? 'reloading' : 'recovering')
          : ready,
    );
    assert.equal((await f.run()).ready, true);
    assert.equal(f.now(), 45_000);
    assert.equal(f.evidence()?.maxWaitMs, 90_000);
  });
  it('should wait through gateway startup and plugin replacement before starting authentication', async () => {
    const f = fixture((path, now) => {
      if (path === '/startupz')
        return now < 500 ? { statusCode: 503, body: { ok: false, status: 'starting' } } : started;
      return now < 11_500 ? loading(now < 10_000 ? 'reloading' : 'recovering') : ready;
    });
    const result = await f.run();
    assert.equal(result.ready, true);
    assert.equal(result.checks, 47);
    assert.equal(f.calls.length, 47);
    assert.deepEqual(f.sleeps, Array(23).fill(500));
    assert.equal(f.now(), 11_500);
    assert.equal(f.calls.at(-1)?.path, '/readyz');
  });

  it('should retain malformed or absent response evidence when an existing probe consumes the remaining budget', async () => {
    for (const probe of [
      { statusCode: 200, body: undefined, malformed: true },
      { statusCode: 200, body: undefined },
      { statusCode: 503, body: 'private-token' },
      { statusCode: 503, body: { status: 'private-token' } },
    ]) {
      const f = fixture(() => probe, {}, 500, 500);
      await assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof SessionDispatchConnectionError);
        const evidence = error.sessionDispatchDiagnostic.readinessEvidence!;
        assert.equal(evidence.elapsedMs, 500);
        assert.equal(evidence.maxWaitMs, 500);
        const observation = evidence.observations[0]!;
        assert.equal(observation.elapsedMs, 500);
        assert.equal(observation.statusCode, probe.statusCode);
        assert.equal(
          observation.body,
          probe.body === undefined && !('malformed' in probe)
            ? 'absent'
            : typeof probe.body === 'object'
              ? 'object'
              : 'malformed',
        );
        assert.ok(!JSON.stringify(error).includes('private-token'));
        return true;
      });
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.sleeps, []);
    }
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
        assert.ok(error instanceof SessionDispatchConnectionError);
        const { readinessEvidence, ...diagnostic } = error.sessionDispatchDiagnostic;
        assert.deepEqual(diagnostic, {
          category: 'timeout',
          phase: 'connection',
          reasonCode: 'gateway-readiness-deadline',
        });
        assert.equal(readinessEvidence?.elapsedMs, 90_000);
        assert.equal(readinessEvidence?.maxWaitMs, 90_000);
        assert.equal(readinessEvidence?.totalObservations, f.calls.length);
        assert.equal(readinessEvidence?.observations.length, readinessObservationLimit);
        assert.equal(
          readinessEvidence?.droppedObservations,
          f.calls.length - readinessObservationLimit,
        );
        assert.equal(readinessEvidence?.observations[0]?.elapsedMs, 0);
        assert.deepEqual(
          readinessEvidence?.observations.map(({ elapsedMs }) => elapsedMs),
          [...readinessEvidence!.observations.map(({ elapsedMs }) => elapsedMs)].sort(
            (a, b) => a - b,
          ),
        );
        assert.ok(!JSON.stringify(error).includes('private-token'));
        return true;
      });
      assert.equal(f.now(), 90_000);
      assert.ok(f.calls.every((call) => call.at < 90_000));
    }
  });

  it('should stop on terminal plugin replacement failure without exposing its reason', async () => {
    const f = fixture((path) => (path === '/startupz' ? started : loading('failed')));
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof Error && 'sessionDispatchDiagnostic' in error);
      assert.ok(error instanceof SessionDispatchConnectionError);
      const { readinessEvidence, ...diagnostic } = error.sessionDispatchDiagnostic;
      assert.deepEqual(diagnostic, {
        category: 'gateway-rejected',
        phase: 'connection',
        reasonCode: 'gateway-reload-failed',
      });
      assert.equal(readinessEvidence?.observations.at(-1)?.pluginReloadPhase, 'failed');
      assert.ok(!JSON.stringify(error).includes('private-token'));
      return true;
    });
    assert.equal(f.now(), 0);
  });

  it('should observe unsupported or malformed responses without delaying authenticated fallback', async () => {
    const f = fixture(
      (path, now) => {
        assert.equal(path, '/startupz');
        if (now === 0) throw Object.assign(new Error('private-token'), { code: 'ECONNREFUSED' });
        return { statusCode: 404, body: 'private-token' };
      },
      {},
      2000,
    );
    // unsupported startup falls through to authentication; it is not made a new prerequisite.
    assert.equal((await f.run()).ready, true);
    assert.deepEqual(
      f.calls.map(({ path, at }) => [path, at]),
      [
        ['/startupz', 0],
        ['/startupz', 500],
      ],
    );
    assert.deepEqual(f.sleeps, [500]);
    assert.equal(f.evidence()?.observations[0]?.transport, 'connection-refused');
    assert.equal(f.evidence()?.observations[1]?.statusCode, 404);
    assert.equal(f.evidence()?.observations[1]?.body, 'malformed');
    assert.ok(!JSON.stringify(f.evidence()).includes('private-token'));

    const malformed = fixture(() => ({ statusCode: 200, body: undefined, malformed: true }));
    // malformed startup also falls through without probing readyz.
    assert.equal((await malformed.run()).ready, true);
    assert.equal(malformed.evidence()?.observations[0]?.body, 'malformed');
    assert.equal(malformed.calls.length, 1);
  });

  it('should retain reload phase transitions without changing probe or sleep order', async () => {
    const phases = fixture(
      (path, now) =>
        path === '/startupz' ? started : loading(now === 0 ? 'reloading' : 'recovering'),
      {},
      1000,
    );
    await assert.rejects(phases.run(), (error: unknown) => {
      assert.ok(error instanceof SessionDispatchConnectionError);
      const evidence = error.sessionDispatchDiagnostic.readinessEvidence!;
      assert.deepEqual(
        evidence.observations
          .filter(({ path }) => path === '/readyz')
          .map(({ pluginReloadPhase }) => pluginReloadPhase),
        ['reloading', 'recovering'],
      );
      return true;
    });
    assert.deepEqual(phases.sleeps, [500, 500]);
    assert.deepEqual(
      phases.calls.map(({ path, at }) => [path, at]),
      [
        ['/startupz', 0],
        ['/readyz', 0],
        ['/startupz', 500],
        ['/readyz', 500],
      ],
    );
  });

  it('should distinguish safe transport categories and no completed probe at an immediate deadline', async () => {
    for (const [code, transport] of [
      ['ECONNREFUSED', 'connection-refused'],
      ['ECONNRESET', 'connection-reset'],
      ['ETIMEDOUT', 'timeout'],
      ['PROBE_TIMEOUT', 'timeout'],
      ['PROBE_RESPONSE_TOO_LARGE', 'response-too-large'],
      ['private-token', 'unknown'],
    ] as const) {
      const f = fixture(
        () => {
          throw Object.assign(new Error('private-token'), { code });
        },
        {},
        500,
      );
      await assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof SessionDispatchConnectionError);
        const observation = error.sessionDispatchDiagnostic.readinessEvidence!.observations[0]!;
        assert.equal(observation.transport, transport);
        assert.equal(observation.statusCode, null);
        assert.equal(observation.body, 'absent');
        assert.ok(!JSON.stringify(error).includes('private-token'));
        return true;
      });
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.sleeps, [500]);
    }
    const f = fixture(() => assert.fail('no probe after deadline'), {}, 0);
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof SessionDispatchConnectionError);
      assert.deepEqual(error.sessionDispatchDiagnostic.readinessEvidence, {
        state: 'observed',
        elapsedMs: 0,
        maxWaitMs: 0,
        totalObservations: 0,
        droppedObservations: 0,
        observations: [],
      });
      return true;
    });
    assert.deepEqual(f.sleeps, []);
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
