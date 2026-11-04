import { nativeObject } from './automation-gateway.ts';
import { dispatchHistoryPages, nativeHistoryPages } from './codex-dispatch-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';

function delegation(item: Record<string, unknown>) {
  return (
    item.type === 'functionCallOutput' &&
    item.namespace === 'codex_app' &&
    ['create_thread', 'send_message_to_thread'].includes(String(item.name))
  );
}

/** Resolve native input ancestry without granting authority to quoted envelopes or saved flags. */
export default async function codexInputAuthority(
  request: CodexThreadRequest,
  threadId: string,
  items: Record<string, unknown>[],
  inputId?: string,
  ancestors = new Set<string>(),
): Promise<{ inputId: string; message: string }> {
  const fail = (): never => {
    throw new Error('reply-native-user-input-required');
  };
  const index =
    inputId === undefined
      ? items.findLastIndex((item) => item.type === 'userMessage' || delegation(item))
      : items.findIndex((item) => item.id === inputId);
  const item = items[index];
  if (
    !item ||
    typeof item.id !== 'string' ||
    !item.id ||
    items.filter((entry) => entry.id === item.id).length !== 1
  )
    return fail();
  // A retained input remains valid after human steering, but cannot authorize a new sender.
  if (inputId !== undefined && items.slice(index + 1).some(delegation)) return fail();
  if (item.type === 'userMessage')
    return { inputId: item.id, message: JSON.stringify(item.content) };
  if (!delegation(item) || typeof item.output !== 'string') return fail();
  const envelope =
    /^<codex_delegation>\n {2}<source_thread_id>([^<]*)<\/source_thread_id>\n {2}<input>([\s\S]*)<\/input>\n<\/codex_delegation>$/u.exec(
      item.output,
    );
  if (!envelope) return fail();
  const decode = (value: string) =>
    value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
  const source = decode(envelope[1]!);
  const prompt = decode(envelope[2]!);
  const key = `${threadId}:${item.id}`;
  if (!source || source === threadId || ancestors.has(key)) return fail();
  ancestors.add(key);
  const response = await request('thread/read', { threadId: source, includeTurns: false });
  if (!nativeObject(response.thread) || response.thread.id !== source) return fail();
  for await (const turns of nativeHistoryPages(request, 'thread/turns/list', {
    threadId: source,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
  })) {
    for (const turn of turns) {
      if (typeof turn.id !== 'string') return fail();
      const entries = await dispatchHistoryPages(request, 'thread/items/list', {
        threadId: source,
        turnId: turn.id,
        sortDirection: 'asc',
      });
      if (entries.some((entry) => entry.turnId !== turn.id || !nativeObject(entry.item)))
        return fail();
      const sourceItems = entries.map((entry) => entry.item).filter(nativeObject);
      const matches = sourceItems.filter(
        (call) =>
          call.type === 'mcpToolCall' &&
          call.server === 'codex_app' &&
          call.tool === item.name &&
          nativeObject(call.arguments) &&
          call.arguments.prompt === prompt &&
          (call.arguments.hostId === undefined || call.arguments.hostId === 'local') &&
          (item.name === 'create_thread' || call.arguments.threadId === threadId),
      );
      if (!matches.length) continue;
      if (matches.length !== 1) return fail();
      const call = matches[0]!;
      if (codexTurnApprovalDenied(sourceItems)) throw new Error('reply-native-approval-denied');
      // The receiving native item proves delivery even while the sending tool is still returning.
      if (
        !['completed', 'inProgress'].includes(String(call.status)) ||
        call.error != null ||
        (nativeObject(call.result) && call.result.isError === true) ||
        (turn.status === 'interrupted' &&
          typeof turn.completedAt === 'number' &&
          turn.completedAt > 0)
      )
        return fail();
      const before = sourceItems.slice(0, sourceItems.indexOf(call));
      const origin = await codexInputAuthority(request, source, before, undefined, ancestors);
      // Carry the original direction and subsequent human restrictions, not just the delegate's paraphrase.
      return {
        inputId: item.id,
        message: JSON.stringify({
          originatingInput: origin.message,
          sourceUserInputs: sourceItems
            .filter((entry) => entry.type === 'userMessage')
            .map((entry) => entry.content),
          delegatedInput: prompt,
        }),
      };
    }
  }
  return fail();
}
