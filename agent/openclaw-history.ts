import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import { sessionObject } from './openclaw-session-create.ts';

export interface HistoryScope {
  sessionKey: string;
  sessionId: string;
}

/** follow native cursors within the requesting owner's deadline and cancellation. */
export async function* openClawHistoryPages(
  request: DispatchRequest,
  scope: HistoryScope,
  options: { messageId?: string; first?: Record<string, unknown> } = {},
) {
  const cursors = new Set<string>();
  let params: Record<string, unknown> = options.messageId
    ? { sessionKey: scope.sessionKey, sessionId: scope.sessionId, messageId: options.messageId }
    : { sessionKey: scope.sessionKey };
  let page = options.first;
  while (true) {
    page ??= sessionObject(await request('chat.history', params));
    if (page.sessionId !== scope.sessionId || !Array.isArray(page.messages))
      throw new Error('workflow-evidence-conflicting');
    yield page.messages.map(sessionObject);
    const cursor = options.messageId ? page.newerCursor : page.olderCursor;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor))
        throw new Error('workflow-evidence-incomplete');
      cursors.add(cursor);
      params = { sessionKey: scope.sessionKey, cursor };
    } else if (!options.messageId && page.hasMore === true) {
      // older hosts expose offset pagination; a short display page is not exhaustion.
      const offset = page.nextOffset;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset <= 0)
        throw new Error('workflow-evidence-incomplete');
      const key = `offset:${offset}`;
      if (cursors.has(key)) throw new Error('workflow-evidence-incomplete');
      cursors.add(key);
      params = { sessionKey: scope.sessionKey, offset };
    } else return;
    page = undefined;
  }
}

/** exact addressing does not remove within-message truncation. */
export async function completeOpenClawMessage(
  request: DispatchRequest,
  scope: HistoryScope,
  message: Record<string, unknown>,
) {
  const meta = sessionObject(message.__openclaw);
  if (meta.truncated !== true) return message;
  if (typeof meta.id !== 'string' || !meta.id) throw new Error('workflow-evidence-truncated');
  const result = sessionObject(
    await request('chat.message.get', {
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      messageId: meta.id,
    }),
  );
  if (result.ok !== true) {
    if (result.unavailableReason === 'not_found') throw new Error('workflow-evidence-missing');
    if (result.unavailableReason === 'oversized') throw new Error('workflow-evidence-truncated');
    throw new Error('workflow-evidence-unavailable');
  }
  const complete = sessionObject(result.message);
  const identity = sessionObject(complete.__openclaw);
  if (
    identity.id !== meta.id ||
    complete.role !== message.role ||
    (message.idempotencyKey !== undefined && complete.idempotencyKey !== message.idempotencyKey) ||
    ['runId', 'idempotencyKey', 'senderIsOwner', 'runTerminal', 'mirrorOrigin'].some(
      (key) => meta[key] !== undefined && identity[key] !== meta[key],
    )
  )
    throw new Error('workflow-evidence-conflicting');
  if (identity.truncated === true) throw new Error('workflow-evidence-truncated');
  return complete;
}
