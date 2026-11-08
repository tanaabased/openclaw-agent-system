import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  describeIssueSession,
  sessionObject,
  type DispatchCaller,
} from './openclaw-session-create.ts';
import { openClawConsumedInput } from './openclaw-turn.ts';

/** Explicit context selection survives a native queued turn changing execution identity. */
export function selectedOpenClawFeedback(record: OpenClawDispatchRecord, runId: string) {
  const selection = record.feedback?.context;
  const events =
    record.feedback?.events.filter((event) =>
      selection?.runId === runId
        ? event.id === selection.eventId
        : (event.turn?.executionRunId ?? event.turn?.runId) === runId,
    ) ?? [];
  return events.length === 1 ? events[0] : undefined;
}

/** Verify delivery to the owning chat; a later run may explicitly answer the same source. */
export default async function openClawFeedbackInput(
  record: OpenClawDispatchRecord,
  caller: Pick<DispatchCaller, 'sessionKey' | 'sessionId' | 'runId'>,
  request: DispatchRequest,
  config: OpenClawConfig,
  eventId?: string,
) {
  const events = eventId
    ? (record.feedback?.events.filter((event) => event.id === eventId) ?? [])
    : [selectedOpenClawFeedback(record, caller.runId)].filter((event) => event !== undefined);
  if (events.length > 1) throw new Error('feedback-native-input-ambiguous');
  const event = events[0];
  if (!event?.native) return;
  if (
    record.threadId !== caller.sessionKey ||
    record.sessionCreation?.sessionId !== caller.sessionId ||
    record.reset ||
    record.supersededBy ||
    !event.turn ||
    event.turn.cancelled
  )
    throw new Error('reply-managed-context-invalid');
  await describeIssueSession(request, record, config, 'conversation');
  const history = sessionObject(
    await request('chat.history', {
      sessionKey: caller.sessionKey,
      inputRunIds: [event.turn!.runId],
    }),
  );
  if (history.sessionId !== caller.sessionId || !Array.isArray(history.messages))
    throw new Error('feedback-input-unverified');
  const inputId = await openClawConsumedInput(request, caller, event.turn!, history, true);
  const selection = record.feedback?.context;
  if (!eventId && selection?.runId === caller.runId && selection.inputEventId !== inputId)
    throw new Error('feedback-input-unverified');
  return { event, inputId };
}
