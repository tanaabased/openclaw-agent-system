import type codexContinuationNative from '../implementation/codex-continuation-native.ts';
import type { DispatchRecord } from '../dispatch/codex-dispatch-state.ts';

/** Reuse the exact native-send receipt; delegated feedback is never an operator input. */
export default async function codexFeedbackInput(
  records: DispatchRecord[],
  caller: string,
  turnId: string,
  receiptFor: ReturnType<typeof codexContinuationNative>,
  selectedEventId?: string,
) {
  const candidates = records.flatMap((record) =>
    record.threadId === caller
      ? (record.feedback?.events ?? []).flatMap((event) =>
          event.attempt &&
          (selectedEventId
            ? event.id === selectedEventId
            : !event.attempt.turnId || event.attempt.turnId === turnId)
            ? [{ record, event, attempt: event.attempt }]
            : [],
        )
      : [],
  );
  const verified = [];
  for (const candidate of candidates) {
    let receipt: Awaited<ReturnType<typeof receiptFor>>;
    try {
      receipt = await receiptFor(candidate.record.sourceThreadId, candidate.attempt);
    } catch (error) {
      if (selectedEventId || candidate.attempt.turnId === turnId) throw error;
      continue;
    }
    if (receipt.status === 'blocked') {
      if (
        selectedEventId ||
        candidate.attempt.turnId === turnId ||
        ('turnId' in receipt && receipt.turnId === turnId)
      )
        throw new Error(receipt.code);
      continue;
    }
    if (receipt.status !== 'verified') continue;
    if (selectedEventId) {
      if (candidate.attempt.turnId && candidate.attempt.turnId !== receipt.turnId)
        throw new Error('feedback-turn-changed');
      if (candidate.attempt.request.threadId !== caller)
        throw new Error('feedback-native-binding-mismatch');
    } else if (receipt.turnId !== turnId || receipt.ended) continue;
    if (candidate.record.reset || candidate.record.supersededBy)
      throw new Error('reply-managed-context-invalid');
    verified.push(candidate);
  }
  if (verified.length > 1) throw new Error('feedback-native-input-ambiguous');
  return verified[0];
}
