import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

/** an unavailable session is an inference, never proof of deletion or native idleness. */
export default async function observeUnavailableRetirementSession(input: {
  record: OpenClawDispatchRecord;
  agentId: string;
  owner: string;
  code: string;
  request: DispatchRequest;
}) {
  const { record, agentId, owner, request } = input;
  if (
    ![
      'retirement-session-identity-unresolved',
      'dispatch-session-response-invalid-sessions-describe-session-null',
      'session-dispatch-describe-forbidden',
    ].includes(input.code) ||
    !record.request ||
    !record.worktree ||
    record.request.cwd !== record.worktree ||
    record.sourceThreadId !== owner
  )
    return undefined;
  const intent = record.request;
  const key = 'key' in intent ? intent.key : (record.native?.sessionKey ?? record.threadId);
  if (
    key === owner ||
    (record.threadId && key !== record.threadId) ||
    ('key' in intent
      ? intent.agentId !== agentId
      : !record.creationCall ||
        (record.native &&
          (record.native.sourceSessionId !== record.creationCall.sessionId ||
            record.native.toolCallId !== record.creationCall.toolCallId)))
  )
    return undefined;
  if (!key) return 'identity-unresolved' as const;
  const description = await request('sessions.describe', { key }).then(
    (value) => ({ value, denied: false as const }),
    (error: unknown) => {
      if (error instanceof Error && error.message === 'session-dispatch-describe-forbidden')
        return { denied: true as const };
      throw error;
    },
  );
  if (description.denied) return 'access-denied' as const;
  const result = description.value;
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !('session' in result) ||
    result.session !== null
  )
    return undefined;
  return 'not-found' as const;
}
