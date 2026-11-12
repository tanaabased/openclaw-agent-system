/** recovery restrictions concern the selected task, never other tasks owned by the caller. */
export default function taskRecoveryCaller(
  record: {
    threadId?: string;
    receiptThreadId?: string;
    sourceThreadId?: string;
    preparationObservation?: { sourceThreadId?: string };
  },
  caller: string,
): boolean {
  return [
    record.threadId,
    record.receiptThreadId,
    record.sourceThreadId,
    record.preparationObservation?.sourceThreadId,
  ].includes(caller);
}
