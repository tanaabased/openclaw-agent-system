import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  describeIssueSession,
  sessionObject,
  type DispatchCaller,
} from './openclaw-session-create.ts';
import { openClawHistoryPages } from './openclaw-history.ts';
import { openClawConsumedInput } from './openclaw-turn.ts';

/** The enrolled session and consumed source receipt bind feedback to this native run. */
export default async function openClawFeedbackInput(
  record: OpenClawDispatchRecord,
  caller: DispatchCaller,
  request: DispatchRequest,
  config: OpenClawConfig,
) {
  const events =
    record.feedback?.events.filter(
      (event) => event.native && (event.turn?.executionRunId ?? event.turn?.runId) === caller.runId,
    ) ?? [];
  // Before reconciliation, discover queued custody from native metadata, never model text.
  if (
    !events.length &&
    record.threadId === caller.sessionKey &&
    record.sessionCreation?.sessionId === caller.sessionId
  ) {
    const pending =
      record.feedback?.events.filter(
        (event) =>
          event.native &&
          event.turn &&
          !event.turn.executionRunId &&
          !event.turn.cancelled &&
          event.turn.status !== 'completed',
      ) ?? [];
    if (pending.length) {
      for await (const messages of openClawHistoryPages(request, caller)) {
        events.push(
          ...pending.filter(
            (event) =>
              !events.includes(event) &&
              messages.some((entry) => {
                if (entry.role !== 'user' || entry.__openclaw == null) return false;
                const meta = sessionObject(entry.__openclaw);
                return (
                  meta.runId === caller.runId &&
                  (meta.idempotencyKey ?? entry.idempotencyKey) === `${event.turn!.runId}:user`
                );
              }),
          ),
        );
        if (events.length > 1 || events.length === pending.length) break;
      }
    }
  }
  if (events.length > 1) throw new Error('feedback-native-input-ambiguous');
  const event = events[0];
  if (!event) return;
  if (
    record.threadId !== caller.sessionKey ||
    record.sessionCreation?.sessionId !== caller.sessionId ||
    record.reset ||
    record.supersededBy ||
    event.turn!.cancelled
  )
    throw new Error('reply-managed-context-invalid');
  await describeIssueSession(request, record, config, 'feedback');
  const history = sessionObject(
    await request('chat.history', {
      sessionKey: caller.sessionKey,
      inputRunIds: [event.turn!.runId],
    }),
  );
  if (history.sessionId !== caller.sessionId || !Array.isArray(history.messages))
    throw new Error('feedback-input-unverified');
  const inputId = await openClawConsumedInput(request, caller, event.turn!, history, true);
  if ((event.turn!.executionRunId ?? event.turn!.runId) !== caller.runId)
    throw new Error('feedback-input-unverified');
  return { event, inputId };
}
