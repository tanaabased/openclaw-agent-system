import { nativeObject } from './automation-gateway.ts';
import { dispatchHistoryPages } from './codex-dispatch-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';
import codexSummaryDenial from './codex-summary-denial.ts';
import type { AssessmentSummary } from './assessment-summary-state.ts';

export interface LiveTurnRequest {
  threadId: string;
  turnId: string;
  afterItemId: string;
  summaries?: AssessmentSummary[];
}

/** read the host's native observation receipt, never caller-supplied status or private desktop ipc. */
export default function codexLiveTurn(request: CodexThreadRequest) {
  return async (input: LiveTurnRequest) => {
    const entries = await dispatchHistoryPages(request, 'thread/items/list', {
      threadId: input.threadId,
      turnId: input.turnId,
      sortDirection: 'asc',
    });
    if (entries.some((entry) => entry.turnId !== input.turnId || !nativeObject(entry.item)))
      throw new Error('continuation-observation-history-invalid');
    const items = entries.map((entry) => entry.item).filter(nativeObject);
    if (
      codexTurnApprovalDenied(
        codexSummaryDenial(items, input.threadId, input.turnId, input.summaries),
      )
    )
      return { status: 'denied' as const };
    const boundary = items.findIndex((item) => item.id === input.afterItemId);
    if (boundary < 0) throw new Error('continuation-observation-boundary-missing');
    const observed = items.findLastIndex(
      (item, index) =>
        index > boundary &&
        item.type === 'mcpToolCall' &&
        item.server === 'codex_app' &&
        item.tool === 'read_thread',
    );
    if (observed < 0) return { status: 'required' as const };
    const item = items[observed]!;
    const unresolved = (reason: string) => ({ status: 'unresolved' as const, reason });
    if (
      item.status !== 'completed' ||
      item.error != null ||
      typeof item.id !== 'string' ||
      !nativeObject(item.arguments) ||
      item.arguments.threadId !== input.threadId ||
      item.arguments.turnLimit !== 1 ||
      item.arguments.includeOutputs !== false ||
      (item.arguments.hostId !== undefined && item.arguments.hostId !== 'local') ||
      !nativeObject(item.result) ||
      item.result.isError === true ||
      !Array.isArray(item.result.content) ||
      item.result.content.length !== 1 ||
      !nativeObject(item.result.content[0]) ||
      item.result.content[0].type !== 'text' ||
      typeof item.result.content[0].text !== 'string'
    )
      return unresolved('native-observation-invalid');
    let result: unknown;
    try {
      result = JSON.parse(item.result.content[0].text);
    } catch {
      return unresolved('native-observation-invalid');
    }
    if (
      !nativeObject(result) ||
      result.schemaVersion !== 1 ||
      !nativeObject(result.thread) ||
      result.thread.id !== input.threadId ||
      result.thread.kind !== 'codex' ||
      result.thread.hostId !== 'local' ||
      result.thread.archived === true ||
      result.thread.ephemeral === true ||
      result.thread.canAcceptDirectInput === false ||
      !nativeObject(result.thread.status) ||
      !nativeObject(result.page) ||
      result.page.order !== 'newest_first' ||
      !Array.isArray(result.turns) ||
      result.turns.length !== 1 ||
      !nativeObject(result.turns[0]) ||
      result.turns[0].id !== input.turnId
    )
      return unresolved('native-observation-identity-mismatch');
    if (
      result.thread.status.type !== 'active' ||
      result.turns[0].status !== 'inProgress' ||
      result.turns[0].completedAt !== null ||
      result.turns[0].error != null
    )
      return unresolved('native-observation-turn-inactive');
    // a live read is not a lease: later input or a completed native operation requires another read.
    if (
      items
        .slice(observed + 1)
        .some(
          (entry) =>
            entry.type === 'userMessage' ||
            (['commandExecution', 'fileChange', 'mcpToolCall'].includes(String(entry.type)) &&
              entry.status !== 'inProgress') ||
            (entry.type === 'functionCallOutput' &&
              entry.namespace === 'codex_app' &&
              ['create_thread', 'send_message_to_thread'].includes(String(entry.name))),
        )
    )
      return unresolved('native-observation-superseded');
    const latest = await request('thread/turns/list', {
      threadId: input.threadId,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
      limit: 1,
    });
    const turn = Array.isArray(latest.data) && latest.data[0];
    if (
      !nativeObject(turn) ||
      (Array.isArray(latest.data) && latest.data.length !== 1) ||
      turn.id !== input.turnId ||
      ['completed', 'failed'].includes(String(turn.status)) ||
      (typeof turn.completedAt === 'number' && turn.completedAt > 0)
    )
      return unresolved('native-observation-superseded');
    return { status: 'active' as const, receiptId: item.id };
  };
}
