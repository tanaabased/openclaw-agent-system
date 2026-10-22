import assert from 'node:assert/strict';
import requireDispatchCheck, { dispatchCheckDigest } from '../agent/codex-dispatch-check.ts';
import type { DispatchState } from '../agent/codex-dispatch-state.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';

describe('agent/codex-dispatch-check', () => {
  it('should require a current terminal check and invalidate it when work changes', () => {
    const state: DispatchState = { version: 1, scope: 'scope', records: [] };
    const intake = { records: [], policyDigest: 'policy' } as unknown as IntakeState;
    assert.throws(() => requireDispatchCheck(state, intake, 100), /dispatch-check-required/);
    state.checked = { at: 100, digest: dispatchCheckDigest(state, intake) };
    requireDispatchCheck(state, intake, 100);
    assert.throws(() => requireDispatchCheck(state, intake, 101), /dispatch-check-required/);
    state.intakeReport = {
      fingerprint: 'report',
      problems: [],
      runId: 'run',
      response: 'reported',
    };
    requireDispatchCheck(state, intake, 100);
    intake.policyDigest = 'changed';
    assert.throws(() => requireDispatchCheck(state, intake, 100), /dispatch-check-required/);
  });
});
