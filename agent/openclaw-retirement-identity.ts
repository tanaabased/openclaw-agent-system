import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { validTerminalRecord } from './retain-dispatch-history.ts';

/** compact cleanup receipts identify a native resource without restoring an execution request. */
export default function retirementSessionIdentity(record: OpenClawDispatchRecord, agentId: string) {
  if (record.request)
    return {
      ...record.request,
      sessionId: record.sessionCreation?.attempted ? record.sessionCreation.sessionId : undefined,
    };
  if (validTerminalRecord(record) && record.threadId && record.worktree)
    return {
      key: record.threadId,
      agentId,
      cwd: record.worktree,
      sessionId: record.retainedHistory?.sessionId,
    };
  return undefined;
}
