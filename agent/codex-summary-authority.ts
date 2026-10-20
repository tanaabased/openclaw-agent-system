import { nativeObject } from './automation-gateway.ts';
import { dispatchHistoryPages } from './codex-dispatch-history.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** the active native owner may recover saved output, but never clear a previous native denial. */
export default async function codexSummaryAuthority(
  request: CodexThreadRequest,
  threadId: string,
  turnId: string,
  sourceTurnIds?: string[],
) {
  const turns = await request('thread/turns/list', {
    threadId,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
    limit: 1,
  });
  const turn = Array.isArray(turns.data) && turns.data[0];
  if (
    !nativeObject(turn) ||
    turn.id !== turnId ||
    (typeof turn.completedAt === 'number' && turn.completedAt > 0)
  )
    throw new Error('assessment-summary-turn-ended');
  for (const sourceTurnId of new Set(sourceTurnIds ?? [])) {
    if (sourceTurnId === turnId) continue;
    const history = await dispatchHistoryPages(request, 'thread/turns/list', {
      threadId,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
    });
    const previous = history.find((entry) => entry.id === sourceTurnId);
    if (
      !previous ||
      !['completed', 'failed', 'interrupted'].includes(String(previous.status)) ||
      typeof previous.completedAt !== 'number' ||
      previous.completedAt <= 0
    )
      throw new Error('assessment-summary-turn-unverified');
    const source = await dispatchHistoryPages(request, 'thread/items/list', {
      threadId,
      turnId: sourceTurnId,
      sortDirection: 'asc',
    });
    if (source.some((entry) => entry.turnId !== sourceTurnId || !nativeObject(entry.item)))
      throw new Error('assessment-summary-turn-unverified');
    if (codexTurnApprovalDenied(source.map((entry) => entry.item)))
      throw new Error('assessment-summary-native-approval-denied');
  }
  const entries = await dispatchHistoryPages(request, 'thread/items/list', {
    threadId,
    turnId,
    sortDirection: 'asc',
  });
  if (entries.some((entry) => entry.turnId !== turnId || !nativeObject(entry.item)))
    throw new Error('assessment-summary-turn-unverified');
  if (codexTurnApprovalDenied(entries.map((entry) => entry.item)))
    throw new Error('assessment-summary-native-approval-denied');
}
