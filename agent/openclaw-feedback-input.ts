import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  describeIssueSession,
  sessionObject,
  type DispatchCaller,
} from './openclaw-session-create.ts';
import { openClawConsumedInput } from './openclaw-turn.ts';

/** The enrolled session and consumed source receipt bind feedback to this native run. */
export default async function openClawFeedbackInput(
  record: OpenClawDispatchRecord,
  caller: DispatchCaller,
  request: DispatchRequest,
  config: OpenClawConfig,
) {
  const events =
    record.feedback?.events.filter((event) => event.native && event.turn?.runId === caller.runId) ??
    [];
  if (events.length > 1) throw new Error('feedback-native-input-ambiguous');
  const event = events[0];
  if (!event) return;
  if (
    record.threadId !== caller.sessionKey ||
    record.sessionCreation?.sessionId !== caller.sessionId ||
    record.retired ||
    record.retirement ||
    record.reset ||
    record.supersededBy ||
    event.turn!.cancelled
  )
    throw new Error('reply-managed-context-invalid');
  await describeIssueSession(request, record, config);
  const history = sessionObject(
    await request('chat.history', { sessionKey: caller.sessionKey, inputRunIds: [caller.runId] }),
  );
  if (history.sessionId !== caller.sessionId || !Array.isArray(history.messages))
    throw new Error('feedback-input-unverified');
  const inputId = await openClawConsumedInput(request, caller, event.turn!, history);
  return { event, inputId };
}
