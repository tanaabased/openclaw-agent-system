import { nativeObject } from './automation-gateway.ts';
import { dispatchHistoryPages } from './codex-dispatch-history.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** A publication stays in its active assessment turn and cannot follow a native denial. */
export default async function codexSummaryAuthority(
  request: CodexThreadRequest,
  threadId: string,
  turnId: string,
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
