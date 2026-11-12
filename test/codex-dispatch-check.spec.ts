import assert from 'node:assert/strict';
import requireDispatchCheck, {
  dispatchCheckDigest,
} from '../agent/tasks/dispatch/codex-dispatch-check.ts';
import type {
  DispatchRecord,
  DispatchState,
} from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';

describe('agent/codex-dispatch-check', () => {
  it('should ignore conversation and delivery changes but invalidate changed native capacity', () => {
    const record = {
      id: 'issue',
      threadId: 'chat',
      request: { prompt: 'launch' },
    } as DispatchRecord;
    const state: DispatchState = {
      version: 4,
      scope: 'scope',
      records: [record],
    };
    const intake = { records: [], policyDigest: 'policy' } as unknown as IntakeState;
    state.checked = { at: 100, digest: dispatchCheckDigest(state, intake) };
    record.feedback = { baseline: {}, events: [] } as DispatchRecord['feedback'];
    record.delivery = { reconciled: false } as DispatchRecord['delivery'];
    record.handoff = { at: 101, by: 'chat', turnId: 'work' };
    requireDispatchCheck(state, intake, 100);
    record.nativeInactive = true;
    assert.throws(() => requireDispatchCheck(state, intake, 100), /dispatch-check-required/);
  });
  it('should require a current terminal check and invalidate it when work changes', () => {
    const state: DispatchState = {
      version: 4,
      scope: 'scope',
      records: [],
    };
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
