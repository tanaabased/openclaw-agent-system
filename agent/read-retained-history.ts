import type ColdHistory from './cold-history.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';

/** history is returned as evidence beside current state, never merged into a runnable owner. */
export default async function readRetainedHistory(
  record: SharedDispatchRecord,
  archive: ColdHistory,
  now: number,
) {
  const retained = record.retainedHistory;
  if (!retained) return undefined;
  const entries = [];
  let remaining = 1024 * 1024;
  for (const reference of [...retained.entries].reverse()) {
    let result = await archive.read(reference, now);
    if (
      result.status === 'available' &&
      (!result.value ||
        typeof result.value !== 'object' ||
        !('id' in result.value) ||
        result.value.id !== record.id)
    )
      result = { status: 'history-unavailable' };
    const bytes =
      result.status === 'available' ? Buffer.byteLength(JSON.stringify(result.value)) : 0;
    if (bytes > remaining) {
      entries.push({
        ...reference,
        status: 'available' as const,
        path: archive.location(reference),
        contentsOmitted: true,
      });
      continue;
    }
    remaining -= bytes;
    entries.push({ ...reference, ...result });
  }
  return {
    expired: Boolean(retained.expired),
    entries,
    instruction:
      'Historical evidence only. Large snapshots have an exact private file path for on-demand inspection. Missing or expired detail is unavailable; never reconstruct it or use it to resume work or authorize publication.',
  };
}
