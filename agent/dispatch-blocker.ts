import type { SharedDispatchRecord } from './dispatch-state.ts';

/** failure identity survives removal of the old assessment-shaped error copy. */
export default function dispatchBlocker(record?: SharedDispatchRecord) {
  return (
    record?.blocker ??
    (record?.result?.outcome === 'operator-setup-blocker' ? record.result.code : undefined)
  );
}
