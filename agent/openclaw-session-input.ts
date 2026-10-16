import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { sessionObject } from './openclaw-session-create.ts';

/** user input custody is journaled by idempotency key; run metadata is optional. */
export function issueInputEventId(entry: Record<string, unknown>, runId: string) {
  const key = `${runId}:user`;
  const meta = sessionObject(entry.__openclaw);
  if (
    entry.role !== 'user' ||
    (meta.runId !== undefined && meta.runId !== runId) ||
    typeof meta.id !== 'string' ||
    !meta.id ||
    meta.truncated === true ||
    (meta.idempotencyKey ?? entry.idempotencyKey) !== key ||
    (entry.idempotencyKey !== undefined && entry.idempotencyKey !== key)
  )
    return;
  return meta.id;
}

/** verify exact journaled input before either reconciliation or assessment adopts its identity. */
export default function issueInputEvent(
  entry: Record<string, unknown>,
  turn: Pick<NonNullable<OpenClawDispatchRecord['assessmentTurn']>, 'runId' | 'message'>,
) {
  const content =
    typeof entry.content === 'string'
      ? entry.content
      : Array.isArray(entry.content) &&
          entry.content.every((block) => {
            const part = sessionObject(block);
            return part.type === 'text' && typeof part.text === 'string';
          })
        ? entry.content.map((block) => sessionObject(block).text).join('')
        : undefined;
  if (content !== turn.message) return;
  return issueInputEventId(entry, turn.runId);
}
