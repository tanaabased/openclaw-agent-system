import { automationHash } from './automation-hash.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { OpenClawIntakePass } from './openclaw-intake-pass.ts';

/** consumed allowance survives removal of the original native request or feedback body. */
export default function intakePassStarted(
  pass: OpenClawIntakePass,
  records: readonly OpenClawDispatchRecord[],
) {
  return pass.selected.filter(
    (id) =>
      !pass.recovery.includes(id) &&
      (pass.started?.includes(id) ||
        records.some(
          (record) =>
            record.id === id &&
            ((record.work &&
              pass.candidates.includes(automationHash({ implementation: record.id }))) ||
              (record.request &&
                pass.candidates.includes(record.intakeId ?? record.manualIssue!.id)) ||
              record.feedback?.events.some(
                (event) => pass.candidates.includes(event.id) && event.turn,
              )),
        )),
  );
}
