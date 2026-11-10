import { Value } from 'typebox/value';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import { codexWorkStateSchema } from './codex-work-state.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
type Record = DispatchRecord & OpenClawDispatchRecord;
export function validNativeDispatchRecord(source: SharedDispatchRecord) {
  const record = source as Record;
  if (record.nativeWork && !Value.Check(codexWorkStateSchema, record.nativeWork)) return false;
  const turns = record.nativeTurns ?? [];
  return (
    new Set(turns.map(({ turn }) => turn.runId)).size === turns.length &&
    turns.every(
      ({ role, turn }) =>
        role !== 'feedback' &&
        (turn.status === 'completed' ? turn.message === undefined : Boolean(turn.message)) &&
        ['consumed', 'completed'].includes(turn.status) === Boolean(turn.consumedByEventId) &&
        (!turn.replyEventId || turn.status === 'completed') &&
        (!turn.failed || turn.status === 'completed') &&
        (turn.status !== 'completed' || turn.failed || Boolean(turn.replyEventId)),
    )
  );
}
