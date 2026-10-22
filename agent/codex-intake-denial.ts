import { nativeObject } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';
import { dispatchHistoryPages } from './codex-dispatch-history.ts';
import validateDispatchRequest from './codex-dispatch-request.ts';
import type {
  DispatchRecord,
  IntakeDenial,
  PreparationObservation,
} from './codex-dispatch-state.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';
import providerErrorMessage from '../utils/provider-error-message.ts';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** only the fixed one-command transport can establish an item-bound preparation refusal. */
export function matchesDeniedPreparation(
  command: unknown,
  id: string,
  anchor: PreparationObservation,
) {
  if (typeof command !== 'string') return false;
  const prefix =
    [
      anchor.runtime.nodeExecutable,
      anchor.runtime.entrypoint,
      'dispatch',
      'prepare',
      '--plugin-data',
      anchor.runtime.pluginData,
    ]
      .map(quote)
      .join(' ') + " <<'AGENT_SYSTEM_INPUT'\n";
  if (!command.startsWith(prefix) || !command.endsWith('\nAGENT_SYSTEM_INPUT')) return false;
  const body = command.slice(prefix.length, -'\nAGENT_SYSTEM_INPUT'.length);
  if (body.includes('\n')) return false;
  try {
    const input = JSON.parse(body);
    if (!nativeObject(input)) return false;
    const { action, ...request } = input;
    if (action !== 'prepare' || request.id !== id || request.digest !== anchor.digest) return false;
    validateDispatchRequest('prepare', request);
    return true;
  } catch {
    return false;
  }
}

/** observe native non-execution, never model claims or an error string from an executed command. */
export default async function intakeDenial(
  request: CodexThreadRequest,
  record: Pick<
    DispatchRecord,
    | 'id'
    | 'sourceThreadId'
    | 'preparationObservation'
    | 'request'
    | 'preparationTurnId'
    | 'creationAfterItemId'
  >,
  observingPreparation = false,
  recoveryCallId?: string,
): Promise<Omit<IntakeDenial, 'observedAt'> | undefined> {
  const anchor = record.request ? undefined : record.preparationObservation;
  const threadId = anchor?.sourceThreadId ?? record.sourceThreadId;
  const turnId = anchor?.turnId ?? record.preparationTurnId;
  const afterItemId = anchor?.afterItemId ?? record.creationAfterItemId;
  if (!turnId || !afterItemId) return;
  let cursor: string | undefined;
  const cursors = new Set<string>();
  let found = recoveryCallId !== undefined;
  const turns: string[] = recoveryCallId ? [turnId] : [];
  const turnIds = new Set<string>();
  for (let page = 0; page < 20 && !found; page++) {
    const result = await request('thread/turns/list', {
      threadId,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result.data) || !result.data.every(nativeObject))
      throw new Error('dispatch-denial-history-unavailable');
    for (const entry of result.data) {
      if (typeof entry.id !== 'string' || turnIds.has(entry.id))
        throw new Error('dispatch-denial-history-unavailable');
      turnIds.add(entry.id);
      turns.push(entry.id);
      if (entry.id === turnId) {
        found = true;
        break;
      }
    }
    if (found) break;
    if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) break;
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  if (!found) throw new Error('dispatch-denial-history-unavailable');
  const items: Record<string, unknown>[] = [];
  for (const observedTurn of turns.reverse()) {
    const entries = await dispatchHistoryPages(request, 'thread/items/list', {
      threadId,
      turnId: observedTurn,
      sortDirection: 'asc',
    });
    const ids = new Set<string>();
    const allItems = entries.map<Record<string, unknown>>((entry) => {
      if (
        entry.turnId !== observedTurn ||
        !nativeObject(entry.item) ||
        typeof entry.item.id !== 'string' ||
        ids.has(entry.item.id)
      )
        throw new Error('dispatch-denial-history-unavailable');
      ids.add(entry.item.id);
      return { ...entry.item, observedTurn };
    });
    const boundary =
      observedTurn === turnId ? allItems.findIndex((item) => item.id === afterItemId) : -1;
    if (observedTurn === turnId && boundary < 0)
      throw new Error('dispatch-denial-history-unavailable');
    items.push(...allItems.slice(boundary + 1));
  }
  const matches = (item: Record<string, unknown>) =>
    anchor
      ? item.type === 'commandExecution' &&
        matchesDeniedPreparation(item.command, record.id, anchor)
      : item.type === 'mcpToolCall' &&
        item.server === 'codex_app' &&
        item.tool === 'create_thread' &&
        automationHash(item.arguments) === automationHash(record.request);
  const denied = items.filter(
    (item) =>
      codexTurnApprovalDenied([item]) &&
      (recoveryCallId === undefined || (item.id === recoveryCallId && matches(item))),
  );
  if (!denied.length) {
    if (recoveryCallId !== undefined) throw new Error('dispatch-denial-unverified');
    const active = items.filter((item) => matches(item) && item.status === 'inProgress');
    if (
      active.length &&
      (!observingPreparation || active.length !== 1 || active[0]!.observedTurn !== turnId)
    )
      throw new Error('dispatch-denial-execution-unresolved');
    return;
  }
  // any other refused effect leaves workflow scope unknown; no prose-based scope inference.
  if (
    denied.length !== 1 ||
    !matches(denied[0]!) ||
    denied[0]!.observedTurn !== turnId ||
    items.some(
      (item) =>
        matches(item) &&
        item !== denied[0] &&
        !(item.type === 'commandExecution' && item.status === 'failed' && item.exitCode != null),
    )
  )
    throw new Error('dispatch-denial-scope-unresolved');
  const item = denied[0]!;
  if (item.type === 'commandExecution' && (item.processId != null || item.exitCode != null))
    throw new Error('dispatch-denial-execution-unresolved');
  const message = nativeObject(item.error) ? item.error.message : item.aggregatedOutput;
  const automatic =
    typeof message === 'string' &&
    message.startsWith('This action was rejected due to unacceptable risk.\nReason: ') &&
    message.includes('Do not bypass this rejection through a workaround or indirect execution.');
  const reason = automatic
    ? providerErrorMessage(
        message
          .slice('This action was rejected due to unacceptable risk.\nReason: '.length)
          .split('Do not bypass this rejection through a workaround or indirect execution.')[0],
        [
          record.request?.prompt ?? '',
          JSON.stringify(record.request) ?? '',
          typeof item.command === 'string' ? item.command : '',
          anchor?.runtime.pluginData ?? '',
          anchor?.runtime.entrypoint ?? '',
        ],
      )
    : undefined;
  return {
    sourceThreadId: threadId,
    turnId,
    callId: item.id as string,
    operation: anchor ? 'prepare' : 'create',
    automatic,
    ...(reason ? { reason } : {}),
  };
}
