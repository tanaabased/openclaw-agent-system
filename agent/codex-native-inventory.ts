import { nativeObject } from './automations/automation-gateway.ts';
import { nativeHistoryPages } from './tasks/dispatch/codex-dispatch-history.ts';
import { connectCodexCaller, type CodexThreadRequest } from './codex-thread-client.ts';

function resultObject(result: unknown) {
  if (!nativeObject(result)) return;
  if (nativeObject(result.structuredContent)) return result.structuredContent;
  if (!Array.isArray(result.content)) return;
  const parts = result.content.filter(nativeObject).filter((part) => part.type === 'text');
  if (parts.length !== 1 || typeof parts[0]!.text !== 'string') return;
  try {
    const value: unknown = JSON.parse(parts[0]!.text);
    return nativeObject(value) ? value : undefined;
  } catch {
    return;
  }
}

/** Only completed native desktop calls in this turn supply inventories; prose is never a receipt. */
export async function readCodexNativeInventory(request: CodexThreadRequest, caller: string) {
  const turns = await request('thread/turns/list', {
    threadId: caller,
    itemsView: 'notLoaded',
    sortDirection: 'desc',
    limit: 1,
  });
  if (
    !Array.isArray(turns.data) ||
    turns.data.length !== 1 ||
    !nativeObject(turns.data[0]) ||
    typeof turns.data[0].id !== 'string'
  )
    throw new Error('native-inventory-turn-unavailable');
  const turnId = turns.data[0].id;
  let projects: Record<string, unknown> | undefined;
  let nativeInventory: Record<string, unknown> | undefined;
  const threads = new Map<string, unknown>();
  const seen = new Set<string>();
  for await (const page of nativeHistoryPages(request, 'thread/items/list', {
    threadId: caller,
    turnId,
    sortDirection: 'desc',
  })) {
    for (const entry of page) {
      if (entry.turnId !== turnId || !nativeObject(entry.item))
        throw new Error('native-inventory-history-invalid');
      const item = entry.item;
      if (
        item.type !== 'mcpToolCall' ||
        item.server !== 'codex_app' ||
        !nativeObject(item.arguments)
      )
        continue;
      const key =
        item.tool === 'list_projects'
          ? 'projects'
          : item.tool === 'list_threads' &&
              (item.arguments.mode === undefined || item.arguments.mode === 'recent')
            ? 'inventory'
            : item.tool === 'read_thread' &&
                typeof item.arguments.threadId === 'string' &&
                (item.arguments.hostId === undefined || item.arguments.hostId === 'local')
              ? `thread:${item.arguments.threadId}`
              : undefined;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // A newer failed read invalidates an older snapshot; it is not permission to fall back.
      if (item.status !== 'completed' || item.error) continue;
      const result = resultObject(item.result);
      if (!result) continue;
      if (key === 'projects') projects = result;
      else if (key === 'inventory') nativeInventory = result;
      else threads.set(key, result);
    }
  }
  return { projects, nativeInventory, threads: [...threads.values()] };
}

export default async function codexNativeInventory() {
  const caller = process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('native-inventory-caller-required');
  const connection = await connectCodexCaller();
  try {
    return await readCodexNativeInventory(connection.request, caller);
  } finally {
    await connection.close();
  }
}

export function assertNoNativeInventory(input: Record<string, unknown>) {
  for (const key of ['projects', 'threads', 'nativeInventory', 'placementReceipt', 'receipt'])
    if (Object.hasOwn(input, key)) throw new Error('native-inventory-binding-override');
}
