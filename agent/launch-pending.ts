/** launch completion follows native creation and dispatch, never the model's assessment. */
export default function launchPending(record: {
  threadId?: string;
  sessionCreation?: { verified?: true };
  assessmentTurn?: { runId: string; status: string };
}) {
  if (!record.threadId) return true;
  if (record.sessionCreation)
    return (
      !record.sessionCreation.verified ||
      !record.assessmentTurn ||
      !['accepted', 'consumed', 'completed'].includes(record.assessmentTurn.status)
    );
  return false;
}
