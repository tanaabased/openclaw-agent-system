import type { SharedDispatchRecord } from './dispatch-state.ts';

/** Unknown creation outcomes retain their slot until native evidence resolves them. */
export default function dispatchCapacity(records: SharedDispatchRecord[], limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('dispatch-capacity-invalid');
  const occupied = records.filter(
    (record) => !record.retired && !record.handoff && record.request && record.phase !== 'complete',
  ).length;
  return { occupied, available: Math.max(0, limit - occupied) };
}
