/** launch completion follows native creation and dispatch, never the model's assessment. */
export default function launchPending(record: {
  threadId?: string;
  sessionCreation?: { verified?: true };
  nativeTurns?: Array<{ role: string; turn: { runId: string; status: string } }>;
}) {
  if (!record.threadId) return true;
  const turn = record.nativeTurns?.findLast(({ role }) => role === 'assessment')?.turn;
  if (record.sessionCreation)
    return (
      !record.sessionCreation.verified ||
      !turn ||
      !['accepted', 'consumed', 'completed'].includes(turn.status)
    );
  return false;
}
