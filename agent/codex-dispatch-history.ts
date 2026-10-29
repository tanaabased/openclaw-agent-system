import { nativeObject } from './automation-gateway.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** native requests own deadlines and cancellation; page counts do not establish completeness. */
export async function* nativeHistoryPages(
  request: CodexThreadRequest,
  method: 'thread/items/list' | 'thread/turns/list',
  params: Record<string, unknown>,
) {
  const cursors = new Set<string>();
  let cursor = params.cursor;
  while (true) {
    const result = await request(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data) || !result.data.every(nativeObject))
      throw new Error('dispatch-native-response-invalid');
    yield result.data as Record<string, unknown>[];
    if (result.nextCursor == null) return;
    if (
      typeof result.nextCursor !== 'string' ||
      !result.nextCursor ||
      cursors.has(result.nextCursor)
    )
      throw new Error('dispatch-native-response-invalid');
    cursor = result.nextCursor;
    cursors.add(result.nextCursor);
  }
}

export async function dispatchHistoryPages(
  request: CodexThreadRequest,
  method: 'thread/items/list' | 'thread/turns/list',
  params: Record<string, unknown>,
) {
  const entries: Record<string, unknown>[] = [];
  for await (const page of nativeHistoryPages(request, method, params)) entries.push(...page);
  return entries;
}

/** turn metadata has no exact-id selector; discover it without loading unrelated items. */
export async function dispatchTurn(
  request: CodexThreadRequest,
  threadId: string,
  turnId: string,
): Promise<(Record<string, unknown> & { items: unknown[] }) | undefined> {
  for await (const page of nativeHistoryPages(request, 'thread/turns/list', {
    threadId,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
  })) {
    const matches = page.filter((turn) => turn.id === turnId);
    if (matches.length > 1) throw new Error('dispatch-native-response-invalid');
    if (!matches.length) continue;
    const entries = await dispatchHistoryPages(request, 'thread/items/list', {
      threadId,
      turnId,
      sortDirection: 'asc',
    });
    if (entries.some((entry) => entry.turnId !== turnId || !nativeObject(entry.item)))
      throw new Error('dispatch-native-history-changed');
    return { ...matches[0]!, items: entries.map((entry) => entry.item) };
  }
}

export default async function dispatchHistory(
  request: CodexThreadRequest,
  threadId: string,
  all: boolean | string = false,
) {
  const params = { threadId, itemsView: 'notLoaded', sortDirection: 'asc' };
  let turns: Record<string, unknown>[];
  if (typeof all === 'string') {
    turns = [];
    for await (const page of nativeHistoryPages(request, 'thread/turns/list', {
      ...params,
      sortDirection: 'desc',
    })) {
      const boundary = page.findIndex((turn) => turn.id === all);
      turns.push(...(boundary < 0 ? page : page.slice(0, boundary + 1)));
      if (boundary >= 0) break;
    }
    if (!turns.some((turn) => turn.id === all)) throw new Error('dispatch-native-history-missing');
    turns.reverse();
  } else if (all) turns = await dispatchHistoryPages(request, 'thread/turns/list', params);
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
  const turnIds = new Set<string>();
  for (const turn of turns) {
    if (typeof turn.id !== 'string' || turnIds.has(turn.id))
      throw new Error('dispatch-native-response-invalid');
    turnIds.add(turn.id);
  }
  if (all === true) {
    const items = await dispatchHistoryPages(request, 'thread/items/list', {
      threadId,
      sortDirection: 'desc',
    });
    if (
      items.some(
        (entry) =>
          typeof entry.turnId !== 'string' ||
          !turnIds.has(entry.turnId) ||
          !nativeObject(entry.item),
      )
    )
      throw new Error('dispatch-native-history-changed');
    for (const turn of turns)
      turn.items = items.filter((entry) => entry.turnId === turn.id).map((entry) => entry.item);
  } else {
    for (const turn of turns) {
      const items = await dispatchHistoryPages(request, 'thread/items/list', {
        threadId,
        turnId: turn.id,
        sortDirection: 'asc',
      });
      if (items.some((entry) => entry.turnId !== turn.id || !nativeObject(entry.item)))
        throw new Error('dispatch-native-history-changed');
      turn.items = items.map((entry) => entry.item);
    }
  }
  if (typeof all === 'string') {
    const latest = await request('thread/turns/list', {
      threadId,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
      limit: 1,
    });
    if (
      !Array.isArray(latest.data) ||
      latest.data.length !== 1 ||
      !nativeObject(latest.data[0]) ||
      latest.data[0].id !== turns.at(-1)?.id
    )
      throw new Error('dispatch-native-history-changed');
  }
  return turns;
}
