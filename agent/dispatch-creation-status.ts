import { dispatchFailurePhase } from './dispatch-retry.ts';

/** Report creation facts and actual obstacles without persisting a conversation phase. */
export default function dispatchCreationStatus(
  record:
    | {
        blocker?: string;
        retry?: { code: string; attempts: number };
        request?: unknown;
        threadId?: string;
        effective?: unknown;
      }
    | undefined,
) {
  if (record?.blocker) return dispatchFailurePhase(record, record.blocker);
  if (record?.threadId && record.effective) return 'created';
  return record?.request ? 'creating' : 'routing';
}
