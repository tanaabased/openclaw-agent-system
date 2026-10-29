import { nativeObject } from './automation-gateway.ts';
import { dispatchHistoryPages, nativeHistoryPages } from './codex-dispatch-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** read complete native evidence from preparation forward without scanning unrelated older history. */
export default async function creationHistory(
  request: CodexThreadRequest,
  threadId: string,
  prepared: { createdAt: number; turnId?: string },
  currentTurnId?: string,
) {
  const turns: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  let preparation: Record<string, unknown> | undefined;
  let newerStart = Infinity;
  for await (const page of nativeHistoryPages(request, 'thread/turns/list', {
    threadId,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
  })) {
    for (const turn of page) {
      if (
        !nativeObject(turn) ||
        typeof turn.id !== 'string' ||
        ids.has(turn.id) ||
        typeof turn.startedAt !== 'number' ||
        !Number.isFinite(turn.startedAt) ||
        turn.startedAt > newerStart
      )
        return;
      if (!turns.length && currentTurnId !== undefined && turn.id !== currentTurnId) return;
      ids.add(turn.id);
      const nextStartedAt = newerStart;
      newerStart = turn.startedAt;
      turns.push(turn);
      if (turn.id === currentTurnId) {
        if (turn.startedAt * 1000 <= prepared.createdAt) return;
        continue;
      }
      if (
        turn.status !== 'completed' ||
        typeof turn.completedAt !== 'number' ||
        !Number.isFinite(turn.completedAt) ||
        turn.completedAt < turn.startedAt ||
        turn.completedAt > nextStartedAt
      )
        return;
      if (turn.startedAt * 1000 <= prepared.createdAt) {
        // native turn times are seconds; the retained preparation time is milliseconds.
        if (
          prepared.createdAt >= (turn.completedAt + 1) * 1000 ||
          (prepared.turnId !== undefined && prepared.turnId !== turn.id)
        )
          return;
        preparation = turn;
        break;
      }
    }
    if (preparation) break;
  }
  if (!preparation) return;
  for (const turn of turns) {
    const entries = await dispatchHistoryPages(request, 'thread/items/list', {
      threadId,
      turnId: turn.id,
      sortDirection: 'asc',
    });
    if (!entries.length) return;
    const itemIds = new Set<string>();
    for (const entry of entries) {
      if (
        entry.turnId !== turn.id ||
        !nativeObject(entry.item) ||
        typeof entry.item.id !== 'string' ||
        itemIds.has(entry.item.id)
      )
        return;
      itemIds.add(entry.item.id);
    }
    turn.items = entries.map((entry) => entry.item as Record<string, unknown>);
  }
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
    latest.data[0].id !== turns[0]?.id
  )
    return;
  return { turnId: preparation.id as string, turns };
}
