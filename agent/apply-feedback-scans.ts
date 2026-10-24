import { automationHash } from './automation-hash.ts';

/** unchanged active owners may accept discovery; concurrent results and lifecycle changes win. */
export default function applyFeedbackScans<
  F,
  R extends {
    id: string;
    retired?: unknown;
    retirement?: unknown;
    reset?: unknown;
    feedback?: F;
  },
>(records: R[], scans: readonly { id: string; before: string; feedback: F }[]) {
  let changed = false;
  for (const scan of scans) {
    const record = records.find((entry) => entry.id === scan.id);
    if (
      !record ||
      record.retired ||
      record.retirement ||
      record.reset ||
      automationHash(record) !== scan.before
    )
      continue;
    record.feedback = scan.feedback;
    changed = true;
  }
  return changed;
}
