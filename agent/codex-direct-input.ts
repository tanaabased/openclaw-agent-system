import { nativeObject } from './automation-gateway.ts';
import { dispatchHistoryPages } from './codex-dispatch-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';

/** native turn and user-item identity, not user-authored markers, establish direct input custody. */
export default async function codexDirectInput(
  request: CodexThreadRequest,
  threadId: string,
): Promise<{ turnId: string; inputId: string; message?: string }> {
  const thread = await request('thread/read', { threadId, includeTurns: false });
  if (
    !nativeObject(thread.thread) ||
    thread.thread.id !== threadId ||
    thread.thread.archived === true ||
    thread.thread.canAcceptDirectInput === false
  )
    throw new Error('reply-native-thread-unavailable');
  const turns = await request('thread/turns/list', {
    threadId,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
    limit: 1,
  });
  const turn = Array.isArray(turns.data) && turns.data[0];
  if (
    !nativeObject(turn) ||
    typeof turn.id !== 'string' ||
    (typeof turn.completedAt === 'number' && turn.completedAt > 0)
  )
    throw new Error('reply-native-turn-unavailable');
  const entries = await dispatchHistoryPages(request, 'thread/items/list', {
    threadId,
    turnId: turn.id,
    sortDirection: 'asc',
  });
  if (entries.some((entry) => entry.turnId !== turn.id || !nativeObject(entry.item)))
    throw new Error('reply-native-input-unverified');
  const items = entries.map((entry) => entry.item).filter(nativeObject);
  if (codexTurnApprovalDenied(items)) throw new Error('reply-native-approval-denied');
  const user = items.findLastIndex((item) => item.type === 'userMessage');
  const delegated = items.findLastIndex(
    (item) =>
      item.type === 'functionCallOutput' &&
      item.namespace === 'codex_app' &&
      ['create_thread', 'send_message_to_thread'].includes(String(item.name)),
  );
  if (user < 0 || typeof items[user]!.id !== 'string' || delegated > user)
    throw new Error('reply-native-user-input-required');
  return {
    turnId: turn.id,
    inputId: items[user]!.id as string,
    message: JSON.stringify(items[user]!.content),
  };
}
