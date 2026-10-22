import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import observeUnavailableRetirementSession from './openclaw-retirement-unavailable.ts';
import workflowFailure from './workflow-failure.ts';

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
  if (!record.request) return undefined;
  const intent = record.request;
  const expected =
    'key' in intent
      ? { key: intent.key, sessionId: record.sessionCreation?.sessionId }
      : record.native;
  if (
    !expected?.sessionId ||
    !('key' in intent
      ? record.sessionCreation?.attempted && intent.agentId === agentId
      : record.creationCall &&
        record.creationCall.sessionId === record.native?.sourceSessionId &&
        record.creationCall.toolCallId === record.native?.toolCallId) ||
    (record.threadId &&
      record.threadId !== ('key' in expected ? expected.key : expected.sessionKey)) ||
    record.worktree !== intent.cwd
  )
    throw new Error('retirement-session-identity-unresolved');
  const key = 'key' in expected ? expected.key : expected.sessionKey;
  const row = retirementObject(
    retirementObject(await request('sessions.describe', { key }), 'sessions-describe').session,
    'sessions-describe-session',
  );
  if (
    row.key !== key ||
    row.agentId !== agentId ||
    row.sessionId !== expected.sessionId ||
    (row.spawnedCwd ?? row.workspaceDir) !== record.worktree
  )
    throw new Error('retirement-session-identity-changed');
  const history = retirementObject(
    await request('chat.history', { sessionKey: key, limit: 1 }),
    'chat-history',
  );
  if (history.sessionId !== row.sessionId || !Array.isArray(history.messages))
    throw new Error('retirement-session-history-unavailable');
  const info = retirementObject(history.sessionInfo, 'chat-history-session-info');
  const pending = retirementObject(history.pendingInputs, 'chat-history-pending-inputs');
  const last = history.messages.at(-1);
  return {
    row,
    archived: row.archived === true || Boolean(row.archivedAt),
    idle: info.hasActiveRun === false && pending.total === 0,
    ...(typeof info.activeLeafEntryId === 'string'
      ? { activityId: info.activeLeafEntryId }
      : last && typeof retirementObject(last, 'chat-history-last-message').id === 'string'
        ? { activityId: String(retirementObject(last, 'chat-history-last-message').id) }
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
