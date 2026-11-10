import type { SharedDispatchRecord } from './dispatch-state.ts';
export default function dispatchBlocker(record?: SharedDispatchRecord) {
  return record?.blocker;
}
