/** History totals include retained inputs which are no longer in the native execution queue. */
export default function liveQueueCount(pending: Record<string, unknown>) {
  // On older hosts without a queue count, keep the conservative history-based fallback.
  const count = pending.queuedCount === undefined ? pending.total : pending.queuedCount;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}
