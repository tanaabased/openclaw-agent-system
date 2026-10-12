import { nativeObject } from './automation-gateway.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** Read bounded native pages; incomplete evidence never authorizes another creation. */
export async function dispatchHistoryPages(
  request: CodexThreadRequest,
  method: 'thread/items/list' | 'thread/turns/list',
  params: Record<string, unknown>,
) {
  const entries: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await request(method, { ...params, limit: 50, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data) || !result.data.every(nativeObject))
      throw new Error('dispatch-native-response-invalid');
    entries.push(...result.data);
    if (result.nextCursor == null) return entries;
    if (
      typeof result.nextCursor !== 'string' ||
      !result.nextCursor ||
      cursors.has(result.nextCursor)
    )
      throw new Error('dispatch-native-response-invalid');
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error('dispatch-native-history-incomplete');
}

export default async function dispatchHistory(
  request: CodexThreadRequest,
  threadId: string,
  all = false,
) {
  const params = { threadId, itemsView: 'notLoaded', sortDirection: 'asc' };
  let turns: Record<string, unknown>[];
  if (all) turns = await dispatchHistoryPages(request, 'thread/turns/list', params);
  else {
    turns = [];
    for (const sortDirection of ['asc', 'desc']) {
      const result = await request('thread/turns/list', { ...params, sortDirection, limit: 1 });
      if (!Array.isArray(result.data) || !result.data.every(nativeObject) || result.data.length > 1)
        throw new Error('dispatch-native-response-invalid');
      const turn = result.data[0];
      if (turn && !turns.some((entry) => entry.id === turn.id)) turns.push(turn);
    }
  }
  for (const turn of turns) {
    if (typeof turn.id !== 'string') throw new Error('dispatch-native-response-invalid');
  }
  if (all) {
    const items = await dispatchHistoryPages(request, 'thread/items/list', {
      threadId,
      sortDirection: 'desc',
    });
    for (const turn of turns)
      turn.items = items.filter((entry) => entry.turnId === turn.id).map((entry) => entry.item);
  } else {
    for (const turn of turns) {
      const items = await dispatchHistoryPages(request, 'thread/items/list', {
        threadId,
        turnId: turn.id,
        sortDirection: 'asc',
      });
      turn.items = items.map((entry) => entry.item);
    }
  }
  return turns;
}
