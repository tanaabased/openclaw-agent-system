import { nativeObject } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';
import type { CodexContinuationState } from './codex-continuation-state.ts';
import dispatchHistory, { dispatchHistoryPages } from './codex-dispatch-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** reconcile the exact native send, never a model claim that it sent a message. */
export default function codexContinuationNative(request: CodexThreadRequest) {
  return async (
    sourceThreadId: string,
    attempt: NonNullable<CodexContinuationState['attempt']>,
  ) => {
    const entries = await dispatchHistoryPages(request, 'thread/items/list', {
      threadId: sourceThreadId,
      turnId: attempt.sourceTurnId,
      sortDirection: 'asc',
    });
    if (entries.some((entry) => entry.turnId !== attempt.sourceTurnId || !nativeObject(entry.item)))
      throw new Error('continuation-source-unavailable');
    const calls = entries
      .map((entry) => entry.item)
      .filter(
        (item) =>
          nativeObject(item) &&
          item.type === 'mcpToolCall' &&
          item.server === 'codex_app' &&
          item.tool === 'send_message_to_thread' &&
          automationHash(item.arguments) === automationHash(attempt.request),
      );
    if (calls.length > 1) throw new Error('continuation-send-duplicated');
    const call = calls[0];
    if (!nativeObject(call)) return { status: 'uncertain' as const };
    if (call.status === 'failed')
      return { status: 'blocked' as const, code: 'continuation-native-send-failed' };
    const target = await dispatchHistory(request, attempt.request.threadId, true);
    const before = target.findIndex((entry) => entry.id === attempt.beforeTurnId);
    if (before < 0) throw new Error('continuation-history-incomplete');
    const escaped = (value: string) =>
      value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    const envelope =
      '<codex_delegation>\n  <source_thread_id>' +
      escaped(sourceThreadId) +
      '</source_thread_id>\n  <input>' +
      escaped(attempt.request.prompt) +
      '</input>\n</codex_delegation>';
    const candidates = target
      .slice(before + 1)
      .filter(
        (entry) =>
          Array.isArray(entry.items) &&
          entry.items.some(
            (item) =>
              nativeObject(item) &&
              ((item.type === 'functionCallOutput' &&
                item.namespace === 'codex_app' &&
                item.name === 'send_message_to_thread' &&
                item.output === envelope) ||
                (call.status === 'completed' &&
                  item.type === 'userMessage' &&
                  Array.isArray(item.content) &&
                  item.content.length === 1 &&
                  nativeObject(item.content[0]) &&
                  item.content[0].type === 'text' &&
                  item.content[0].text === attempt.request.prompt)),
          ),
      );
    if (candidates.length > 1) throw new Error('continuation-turn-ambiguous');
    const found = candidates[0];
    if (!found) return { status: 'uncertain' as const };
    if (typeof found.id !== 'string') throw new Error('continuation-turn-invalid');
    if (
      Array.isArray(found.items) &&
      found.items.some((item) => {
        if (!nativeObject(item)) return false;
        if (item.type === 'commandExecution' || item.type === 'fileChange')
          return item.status === 'declined';
        if (
          item.type !== 'mcpToolCall' ||
          item.status !== 'failed' ||
          item.result != null ||
          !nativeObject(item.error)
        )
          return false;
        const message = item.error.message;
        return (
          message === 'user rejected MCP tool call' ||
          (typeof message === 'string' &&
            message.startsWith('This action was rejected due to unacceptable risk.\nReason: ') &&
            message.includes(
              'Do not bypass this rejection through a workaround or indirect execution.',
            ))
        );
      })
    )
      return { status: 'blocked' as const, code: 'continuation-native-approval-denied' };
    // a separate app-server can report an active turn as interrupted without an end timestamp.
    const ended =
      ['completed', 'failed', 'interrupted'].includes(String(found.status)) &&
      typeof found.completedAt === 'number' &&
      Number.isFinite(found.completedAt) &&
      found.completedAt > 0;
    return { status: 'verified' as const, turnId: found.id, ended };
  };
}
