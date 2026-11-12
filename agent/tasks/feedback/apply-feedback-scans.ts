import feedbackDiscoveryOwner from './feedback-discovery-owner.ts';
/** unchanged active owners may accept discovery; concurrent feedback and lifecycle changes win. */
export default function applyFeedbackScans<
  F,
  R extends {
    id: string;
    retirement?: unknown;
    reset?: unknown;
    supersededBy?: unknown;
    feedback?: F;
  },
>(
  records: R[],
  scans: readonly {
    id: string;
    before: string;
    feedback: F;
  }[],
) {
  let changed = false;
  for (const scan of scans) {
    const record = records.find((entry) => entry.id === scan.id);
    if (
      !record ||
      record.retirement ||
      record.reset ||
      record.supersededBy ||
      feedbackDiscoveryOwner(record) !== scan.before
    )
      continue;
    record.feedback = scan.feedback;
    changed = true;
  }
  return changed;
}
