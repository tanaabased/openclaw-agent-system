import { automationHash } from './automation-hash.ts';
import type { DispatchState } from './codex-dispatch-state.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';

/** Reporting and delivery do not change which assignments the last dispatch check covered. */
export function dispatchCheckDigest(state: DispatchState, intake: IntakeState) {
  return automationHash({
    records: state.records,
    intake: intake.records,
    policy: intake.policyDigest,
  });
}

export default function requireDispatchCheck(
  state: DispatchState,
  intake: IntakeState,
  occurrence: number,
) {
  if (
    !state.checked ||
    state.checked.at < occurrence ||
    state.checked.digest !== dispatchCheckDigest(state, intake)
  )
    throw new Error('dispatch-check-required');
}
