import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
export function validNativeDispatchRecord(
  source: SharedDispatchRecord,
  runtime: 'codex' | 'openclaw',
) {
  if (runtime === 'codex') return true;
  const record = source as OpenClawDispatchRecord;
  const turns = record.nativeTurns ?? [];
  return (
    new Set(turns.map(({ turn }) => turn.runId)).size === turns.length &&
    turns.every(
      ({ role, turn }) =>
        role !== 'feedback' &&
        (turn.status === 'completed' ? turn.message === undefined : Boolean(turn.message)) &&
        ['consumed', 'completed'].includes(turn.status) === Boolean(turn.consumedByEventId) &&
        (!turn.replyEventId || turn.status === 'completed') &&
        (!turn.executionModel || turn.status === 'completed') &&
        (!turn.failed || turn.status === 'completed') &&
        (turn.status !== 'completed' || turn.failed || Boolean(turn.replyEventId)),
    )
  );
}
