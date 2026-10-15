import { nativeObject } from './automation-gateway.ts';
import { dispatchHistoryPages } from './codex-dispatch-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** prove absence of native creation across the completed preparation turn and later turns. */
export default async function unsubmittedCreation(
  request: CodexThreadRequest,
  threadId: string,
  prepared: { createdAt: number; turnId?: string },
  currentTurnId: string,
): Promise<{ turnId: string } | undefined> {
  const turns: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | undefined;
  let preparation: Record<string, unknown> | undefined;
  let newerStart = Infinity;
  for (let page = 0; page < 20 && !preparation; page++) {
    const result = await request('thread/turns/list', {
      threadId,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result.data) || !result.data.length) return;
    for (const turn of result.data) {
      if (
        !nativeObject(turn) ||
        typeof turn.id !== 'string' ||
        ids.has(turn.id) ||
        typeof turn.startedAt !== 'number' ||
        !Number.isFinite(turn.startedAt) ||
        turn.startedAt > newerStart
      )
        return;
      if (!turns.length && turn.id !== currentTurnId) return;
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
    if (
      typeof result.nextCursor !== 'string' ||
      !result.nextCursor ||
      cursors.has(result.nextCursor)
    )
      return;
    cursor = result.nextCursor;
    cursors.add(cursor);
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
      const item = entry.item;
      if (
        entry.turnId !== turn.id ||
        !nativeObject(item) ||
        typeof item.id !== 'string' ||
        itemIds.has(item.id)
      )
        return;
      itemIds.add(item.id);
      if (['userMessage', 'agentMessage', 'reasoning', 'plan'].includes(String(item.type)))
        continue;
      if (item.type === 'commandExecution') {
        if (turn.id !== currentTurnId && item.status !== 'completed') return;
        continue;
      }
      if (
        item.type === 'mcpToolCall' &&
        typeof item.server === 'string' &&
        typeof item.tool === 'string' &&
        item.tool !== 'create_thread' &&
        item.status === 'completed'
      )
        continue;
      // a call, rejection, compaction, or unknown item cannot prove non-submission.
      return;
    }
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
    latest.data[0].id !== currentTurnId
  )
    return;
  return { turnId: preparation.id as string };
}
