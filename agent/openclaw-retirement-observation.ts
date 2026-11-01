import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import observeUnavailableRetirementSession from './openclaw-retirement-unavailable.ts';
import workflowFailure from './workflow-failure.ts';
import retirementSessionIdentity from './openclaw-retirement-identity.ts';

export function retirementObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const type =
      value === null
        ? 'null'
        : value === undefined
          ? 'missing'
          : Array.isArray(value)
            ? 'array'
            : typeof value;
    throw new Error('dispatch-session-response-invalid-' + field + '-' + type);
  }
  return value as Record<string, unknown>;
}

/** observe the exact native session, including archived sessions and pending inputs. */
export async function observeRetiringSession(
  request: DispatchRequest,
  record: OpenClawDispatchRecord,
  agentId: string,
) {
  const intent = retirementSessionIdentity(record, agentId);
  if (!intent) return undefined;
  if (
    !intent.sessionId ||
    intent.agentId !== agentId ||
    (record.threadId && record.threadId !== intent.key) ||
    record.worktree !== intent.cwd
  )
    throw new Error('retirement-session-identity-unresolved');
  const key = intent.key;
  const row = retirementObject(
    retirementObject(await request('sessions.describe', { key }), 'sessions-describe').session,
    'sessions-describe-session',
  );
  if (
    row.key !== key ||
    row.agentId !== agentId ||
    row.sessionId !== intent.sessionId ||
    (row.spawnedCwd ?? row.workspaceDir) !== record.worktree
  )
    throw new Error('retirement-session-identity-changed');
  const history = retirementObject(
    await request('chat.history', { sessionKey: key, limit: 1 }),
    'chat-history',
  );
  if (history.sessionId !== row.sessionId)
    throw new Error('retirement-session-history-unavailable');
  const info = retirementObject(history.sessionInfo, 'chat-history-session-info');
  let page = history;
  let total: number | undefined;
  let before: number | undefined;
  const seen = new Set<string>();
  let idle = info.hasActiveRun === false;
  for (;;) {
    if (page.sessionId !== row.sessionId) throw new Error('retirement-session-history-unavailable');
    const execution = retirementObject(page.sessionInfo, 'chat-history-session-info');
    const pending = retirementObject(page.pendingInputs, 'chat-history-pending-inputs');
    if (
      !Number.isSafeInteger(pending.total) ||
      Number(pending.total) < 0 ||
      (total !== undefined && total !== pending.total) ||
      (pending.queuedCount !== undefined &&
        (!Number.isSafeInteger(pending.queuedCount) || Number(pending.queuedCount) < 0))
    )
      throw new Error('retirement-pending-inputs-unresolved');
    total = Number(pending.total);
    idle &&= execution.hasActiveRun === false && (pending.queuedCount ?? 0) === 0;
    const items = pending.items ?? (total === 0 ? [] : undefined);
    if (!Array.isArray(items)) throw new Error('retirement-pending-inputs-unresolved');
    for (const item of items) {
      const entry = retirementObject(item, 'chat-history-pending-input');
      if (
        typeof entry.id !== 'string' ||
        !entry.id ||
        seen.has(entry.id) ||
        !['queued', 'cancelled', 'interrupted'].includes(String(entry.state))
      )
        throw new Error('retirement-pending-inputs-unresolved');
      seen.add(entry.id);
      // persisted queued inputs remain unresolved even when the live queue is empty.
      if (entry.state === 'queued' || entry.queued === true) idle = false;
    }
    if (pending.nextBefore === undefined) {
      if (seen.size !== total) throw new Error('retirement-pending-inputs-unresolved');
      break;
    }
    if (
      !Number.isSafeInteger(pending.nextBefore) ||
      Number(pending.nextBefore) < 1 ||
      (before !== undefined && Number(pending.nextBefore) >= before) ||
      !items.length ||
      seen.size >= total
    )
      throw new Error('retirement-pending-inputs-unresolved');
    before = Number(pending.nextBefore);
    page = retirementObject(
      await request('chat.history', {
        sessionKey: key,
        limit: 1,
        pendingBefore: before,
      }),
      'chat-history',
    );
  }
  const last = Array.isArray(history.messages) ? history.messages.at(-1) : undefined;
  return {
    row,
    archived: row.archived === true || Boolean(row.archivedAt),
    idle,
    ...(typeof info.activeLeafEntryId === 'string'
      ? { activityId: info.activeLeafEntryId }
      : last && typeof last === 'object' && typeof last.id === 'string'
        ? { activityId: last.id }
        : {}),
  };
}

/** retirement and operator reset share native observation and unavailable-session classification. */
export default async function observeRetirementSession(
  request: DispatchRequest,
  record: OpenClawDispatchRecord,
  agentId: string,
  owner: string,
) {
  try {
    const observed = await observeRetiringSession(request, record, agentId);
    return observed && { ...observed, unavailableSession: undefined };
  } catch (error) {
    const unavailableSession = await observeUnavailableRetirementSession({
      record,
      agentId,
      owner,
      request,
      code: workflowFailure(error, 'retirement-native-observation-unavailable').code,
    });
    if (!unavailableSession) throw error;
    return { row: undefined, archived: false, idle: false, unavailableSession };
  }
}
