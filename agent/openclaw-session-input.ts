import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { sessionObject } from './openclaw-session-create.ts';

/** verify exact journaled input before either reconciliation or assessment adopts its identity. */
export default function issueInputEvent(
  entry: Record<string, unknown>,
  turn: Pick<NonNullable<OpenClawDispatchRecord['assessmentTurn']>, 'runId' | 'message'>,
) {
  const key = `${turn.runId}:user`;
  const meta = sessionObject(entry.__openclaw);
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
  if (
    entry.role !== 'user' ||
    meta.runId !== turn.runId ||
    typeof meta.id !== 'string' ||
    !meta.id ||
    meta.truncated === true ||
    content !== turn.message ||
    (meta.idempotencyKey ?? entry.idempotencyKey) !== key ||
    (entry.idempotencyKey !== undefined && entry.idempotencyKey !== key)
  )
    return;
  return meta.id;
}
