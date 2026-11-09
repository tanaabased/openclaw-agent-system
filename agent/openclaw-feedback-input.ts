import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  describeIssueSession,
  sessionObject,
  type DispatchCaller,
} from './openclaw-session-create.ts';
import { openClawConsumedInput } from './openclaw-turn.ts';
import issueInputEvent from './openclaw-session-input.ts';
import { completeOpenClawMessage, openClawHistoryPages } from './openclaw-history.ts';

/** recover queued source identity from the native input, without asking the model to select it. */
export async function resolveOpenClawTurnFeedback(
  record: OpenClawDispatchRecord,
  caller: Pick<DispatchCaller, 'sessionKey' | 'sessionId' | 'runId'>,
  request: DispatchRequest,
  config: OpenClawConfig,
  inputId?: string,
) {
  const selected = selectedOpenClawFeedback(record, caller.runId);
  if (selected) {
    const verified = await openClawFeedbackInput(
      structuredClone(record),
      caller,
      request,
      config,
      selected.id,
    );
    if (inputId && verified?.inputId !== inputId) throw new Error('feedback-input-unverified');
    return verified;
  }
  const events = (record.feedback?.events ?? []).filter(
    (event) => event.native && event.turn && !event.turn.cancelled,
  );
  if (!events.length) return;
  if (
    record.threadId !== caller.sessionKey ||
    record.sessionCreation?.sessionId !== caller.sessionId ||
    record.retired ||
    record.reset ||
    record.supersededBy
  )
    throw new Error('reply-managed-context-invalid');
  const history = sessionObject(
    await request('chat.history', {
      sessionKey: caller.sessionKey,
      inputRunIds: events.map((event) => event.turn!.runId),
    }),
  );
  if (history.sessionId !== caller.sessionId || !Array.isArray(history.messages))
    throw new Error('feedback-input-unverified');
  for await (const messages of openClawHistoryPages(request, caller, { first: history })) {
    const matches = [];
    for (const candidate of messages) {
      const meta = sessionObject(candidate.__openclaw);
      if (
        candidate.role !== 'user' ||
        (inputId ? meta.id !== inputId : meta.runId !== caller.runId)
      )
        continue;
      const message = await completeOpenClawMessage(request, caller, candidate);
      for (const event of events) {
        const id = issueInputEvent(message, event.turn!, caller.runId);
        if (id) matches.push({ event, inputId: id });
      }
    }
    if (matches.length > 1) throw new Error('feedback-native-input-ambiguous');
    if (matches.length) return matches[0];
  }
}

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
    record.retired ||
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
  const selection = record.feedback?.context;
  const inputId = await openClawConsumedInput(
    request,
    caller,
    event.turn!,
    history,
    true,
    selection?.eventId === event.id ? selection : undefined,
  );
  if (!eventId && selection?.runId === caller.runId && selection.inputEventId !== inputId)
    throw new Error('feedback-input-unverified');
  return { event, inputId };
}
