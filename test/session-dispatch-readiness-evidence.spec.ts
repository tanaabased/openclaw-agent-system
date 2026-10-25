import assert from 'node:assert/strict';

import {
  classifySessionDispatchFailure,
  retainSessionDispatchDiagnostic,
  SessionDispatchConnectionError,
} from '../credentials/session-dispatch-diagnostic.ts';
import {
  observeReadiness,
  retainReadinessEvidence,
} from '../credentials/session-dispatch-readiness-evidence.ts';

describe('credentials/session-dispatch-readiness-evidence', () => {
  it('should reconstruct only allowlisted values across every diagnostic retention boundary', () => {
    const marker = 'fixture-private-token';
    const observation = observeReadiness('/readyz', 500, {
      statusCode: 503,
      body: {
        ready: false,
        failing: ['plugin-reload', marker],
        pluginReload: { phase: 'recovering', reason: marker },
        token: marker,
      },
    });
    const evidence = {
      state: 'observed' as const,
      elapsedMs: 1000,
      maxWaitMs: 1000,
      totalObservations: 3,
      droppedObservations: 2,
      observations: [observation],
    };
    const error = new SessionDispatchConnectionError({
      category: 'timeout',
      phase: 'connection',
      reasonCode: 'gateway-readiness-deadline',
      readinessEvidence: Object.assign({}, evidence, {
        token: marker,
        observations: [Object.assign({}, observation, { token: marker })],
      }),
    });
    const classified = classifySessionDispatchFailure(error);
    const retained = retainSessionDispatchDiagnostic(classified);
    assert.deepEqual(retained.readinessEvidence, evidence);
    assert.notEqual(retained.readinessEvidence, evidence);
    assert.notEqual(
      retained.readinessEvidence?.observations[0],
      classified.readinessEvidence?.observations[0],
    );
    assert.ok(
      ![error.message, error.stack, JSON.stringify(error), JSON.stringify(retained)]
        .join('')
        .includes(marker),
    );
    assert.match(error.message, /readiness evidence/);
    assert.equal(observation.startupStatus, 'absent');
    assert.equal(observation.pluginReloadFailing, true);
  });

  it('should mark absent, malformed and unsupported fields without copying provider strings', () => {
    const marker = 'fixture-private-token';
    for (const body of [
      undefined,
      null,
      marker,
      [],
      { ok: marker, status: marker, ready: marker, failing: marker, pluginReload: marker },
    ]) {
      const observation = observeReadiness('/startupz', 0, { statusCode: 503, body });
      assert.ok(!JSON.stringify(observation).includes(marker));
      if (body === undefined) assert.equal(observation.body, 'absent');
      else if (typeof body === 'object' && body && !Array.isArray(body)) {
        assert.equal(observation.body, 'object');
        assert.equal(observation.startupOk, 'malformed');
        assert.equal(observation.startupStatus, 'malformed');
        assert.equal(observation.pluginReloadPhase, 'malformed');
      } else assert.equal(observation.body, 'malformed');
    }
    const observation = observeReadiness('/readyz', 0, {
      statusCode: 200,
      body: { ready: false, failing: ['unrelated-channel'] },
    });
    assert.equal(observation.pluginReloadFailing, false);
    assert.equal(observation.pluginReloadPhase, 'absent');
    const forgedMissing = observeReadiness('/startupz', 0, {
      statusCode: 503,
      body: { ok: 'absent', status: 'absent' },
    });
    assert.equal(forgedMissing.startupOk, 'malformed');
    assert.equal(forgedMissing.startupStatus, 'malformed');
    assert.equal(
      observeReadiness('/startupz', 0, { statusCode: 0, body: undefined }).statusCode,
      null,
    );
  });

  it('should reject malformed envelopes and bound forged histories while remaining idempotent', () => {
    const observation = observeReadiness('/startupz', 0, {
      statusCode: 503,
      body: { ok: false, status: 'starting' },
    });
    const valid = {
      state: 'observed',
      elapsedMs: 500,
      maxWaitMs: 500,
      totalObservations: 1,
      observations: [observation],
    };
    for (const evidence of [
      null,
      {},
      { ...valid, elapsedMs: Infinity },
      { ...valid, maxWaitMs: -1 },
      { ...valid, totalObservations: 0 },
      { ...valid, observations: Array(17).fill(observation) },
      { ...valid, observations: [{ ...observation, path: '/private-token' }] },
      { ...valid, observations: [{ ...observation, elapsedMs: 501 }] },
      { ...valid, observations: [{ ...observation, elapsedMs: NaN }] },
      {
        ...valid,
        totalObservations: 2,
        observations: [{ ...observation, elapsedMs: 500 }, observation],
      },
    ]) {
      const safe = retainReadinessEvidence(evidence);
      assert.equal(safe.state, 'malformed');
      assert.deepEqual(safe.observations, []);
      assert.deepEqual(retainReadinessEvidence(safe), safe);
    }
    assert.equal(retainReadinessEvidence(undefined).state, 'absent');
    const safe = retainReadinessEvidence({
      ...valid,
      observations: [
        {
          ...observation,
          statusCode: 900,
          transport: 'private-token',
          startupStatus: 'private-token',
        },
      ],
    });
    assert.equal(safe.observations[0]?.statusCode, null);
    assert.equal(safe.observations[0]?.transport, 'unknown');
    assert.equal(safe.observations[0]?.startupStatus, 'malformed');
    assert.deepEqual(retainReadinessEvidence(safe), safe);
    assert.ok(!JSON.stringify(safe).includes('private-token'));
  });
});
