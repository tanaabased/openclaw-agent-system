import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

/** compact cleanup receipts identify a native resource without restoring an execution request. */
export default function retirementSessionIdentity(record: OpenClawDispatchRecord) {
  if (record.request)
    return {
      ...record.request,
      sessionId: record.sessionCreation?.attempted ? record.sessionCreation.sessionId : undefined,
    };
  return undefined;
}
