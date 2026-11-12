import { nativeObject } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';
import {
  dispatchHistoryPages,
  nativeHistoryPages,
} from './tasks/dispatch/codex-dispatch-history.ts';
import validateDispatchRequest from './tasks/dispatch/codex-dispatch-request.ts';
import type {
  DispatchRecord,
  IntakeDenial,
  PreparationObservation,
} from './tasks/dispatch/codex-dispatch-state.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';
import providerErrorMessage from '../utils/provider-error-message.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';
import { Value } from 'typebox/value';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** only the fixed one-command transport can establish an item-bound preparation refusal. */
export function matchesDeniedPreparation(
  command: unknown,
  id: string,
  anchor: PreparationObservation,
  target?: string,
) {
  if (typeof command !== 'string') return false;
  const prefix =
    [
      anchor.runtime.nodeCommand ?? anchor.runtime.nodeExecutable,
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
    if (
      action === 'prepare' &&
      target &&
      request.target === target &&
      Value.Check(dispatchModelParameters, input)
    )
      return true;
    if (action !== 'prepare' || request.id !== id || request.digest !== anchor.digest) return false;
    validateDispatchRequest('prepare', request);
    return true;
  } catch {
    return false;
  }
}

type DenialRecord = Pick<
  DispatchRecord,
  | 'id'
  | 'sourceThreadId'
  | 'preparationObservation'
  | 'request'
  | 'preparationTurnId'
  | 'creationAfterItemId'
  | 'context'
>;

/** observe native non-execution, never model claims or an error string from an executed command. */
export default async function intakeDenial(
  request: CodexThreadRequest,
  record: DenialRecord,
  observingPreparation = false,
  recoveryCallId?: string,
  otherRecords: DenialRecord[] = [],
): Promise<Omit<IntakeDenial, 'observedAt'> | undefined> {
  const anchor = record.request ? undefined : record.preparationObservation;
  const threadId = anchor?.sourceThreadId ?? record.sourceThreadId;
  const turnId = anchor?.turnId ?? record.preparationTurnId;
  const afterItemId = anchor?.afterItemId ?? record.creationAfterItemId;
  if (!turnId || !afterItemId) return;
  let found = recoveryCallId !== undefined;
  const turns: string[] = recoveryCallId ? [turnId] : [];
  const turnIds = new Set<string>();
  if (!found)
    for await (const page of nativeHistoryPages(request, 'thread/turns/list', {
      threadId,
      itemsView: 'notLoaded',
      sortDirection: 'desc',
    })) {
      for (const entry of page) {
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
    }
  if (!found) throw new Error('dispatch-denial-history-unavailable');
  const items: Record<string, unknown>[] = [];
  const boundaries = new Map<string, string[]>();
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
    boundaries.set(
      observedTurn,
      allItems.map((item) => item.id as string),
    );
    const boundary =
      observedTurn === turnId ? allItems.findIndex((item) => item.id === afterItemId) : -1;
    if (observedTurn === turnId && boundary < 0)
      throw new Error('dispatch-denial-history-unavailable');
    items.push(...allItems.slice(boundary + 1));
  }
  const matchesRecord = (item: Record<string, unknown>, candidate: DenialRecord) => {
    const preparation = candidate.request ? undefined : candidate.preparationObservation;
    return preparation
      ? item.type === 'commandExecution' &&
          matchesDeniedPreparation(
            item.command,
            candidate.id,
            preparation,
            candidate.context ? JSON.parse(candidate.context).source : undefined,
          )
      : Boolean(candidate.request) &&
          item.type === 'mcpToolCall' &&
          item.server === 'codex_app' &&
          item.tool === 'create_thread' &&
          automationHash(item.arguments) === automationHash(candidate.request);
  };
  const matches = (item: Record<string, unknown>) => matchesRecord(item, record);
  const belongsElsewhere = (item: Record<string, unknown>) => {
    if (matches(item)) return false;
    const owners = otherRecords.filter((candidate) => {
      if (candidate.id === record.id) return false;
      const preparation = candidate.request ? undefined : candidate.preparationObservation;
      const source = preparation?.sourceThreadId ?? candidate.sourceThreadId;
      const turn = preparation?.turnId ?? candidate.preparationTurnId;
      const after = preparation?.afterItemId ?? candidate.creationAfterItemId;
      const ids = turn && boundaries.get(turn);
      return (
        source === threadId &&
        turn === item.observedTurn &&
        after &&
        ids &&
        ids.indexOf(after) >= 0 &&
        ids.indexOf(item.id as string) > ids.indexOf(after) &&
        matchesRecord(item, candidate)
      );
    });
    return owners.length === 1;
  };
  const denied = items.filter(
    (item) =>
      codexTurnApprovalDenied([item]) &&
      (recoveryCallId === undefined
        ? !belongsElsewhere(item)
        : item.id === recoveryCallId && matches(item)),
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
  // Only exact retained native operations narrow a denial; unrecognized effects remain ambiguous.
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
