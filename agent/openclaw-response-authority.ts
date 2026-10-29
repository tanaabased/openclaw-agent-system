import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { nativeInputEvent } from './openclaw-session-input.ts';
import issueTurnReply from './openclaw-session-reply.ts';
import {
  describeIssueSession,
  sessionObject,
  type DispatchCaller,
} from './openclaw-session-create.ts';

/** verify the current owner and observe the old execution; saved output alone is insufficient. */
export default async function openClawResponseAuthority(input: {
  request: DispatchRequest;
  record: OpenClawDispatchRecord;
  caller: DispatchCaller;
  config: OpenClawConfig;
  observeOnly?: boolean;
}) {
  const { record, caller, request } = input;
  if (
    caller.sessionKey !== record.threadId ||
    caller.sessionId !== record.sessionCreation?.sessionId
  )
    throw new Error('assessment-summary-binding-mismatch');
  await describeIssueSession(request, record, input.config);
  await nativeInputEvent({
    request,
    sessionKey: caller.sessionKey,
    sessionId: caller.sessionId,
    runId: caller.runId,
    retained: [],
  });
  if (!input.observeOnly && record.resultTurnId && record.resultTurnId !== caller.runId) {
    const observed = sessionObject(
      await request('agent.wait', { runId: record.resultTurnId, timeoutMs: 0 }),
    );
    if (observed.runId !== record.resultTurnId)
      throw new Error('dispatch-assessment-continuation-not-ready');
    if (observed.stopReason === 'aborted' || record.assessmentTurn?.cancelled)
      throw new Error('dispatch-turn-cancelled');
    if (/denied|rejected/.test(String(observed.code ?? '')))
      throw new Error('assessment-summary-native-approval-denied');
    if (['ok', 'error'].includes(String(observed.status))) return;
    if (observed.status !== 'timeout')
      throw new Error('dispatch-assessment-continuation-not-ready');
    // agent.wait is process-local; after restart require the exact native input and terminal reply.
    const original = await nativeInputEvent({
      request,
      sessionKey: caller.sessionKey,
      sessionId: caller.sessionId,
      runId: record.resultTurnId,
      retained: [
        record.assessmentCaller,
        record.turnEvidence,
        ...(record.assessmentHistory ?? []).map((entry) =>
          entry.inputEventId ? { runId: entry.runId, inputEventId: entry.inputEventId } : undefined,
        ),
        record.assessmentTurn?.consumedByEventId
          ? {
              runId: record.assessmentTurn.runId,
              inputEventId: record.assessmentTurn.consumedByEventId,
            }
          : undefined,
      ],
    });
    let history = sessionObject(
      await request('chat.history', {
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        messageId: original.inputEventId,
        limit: 200,
        maxChars: 100000,
        toolResultMaxChars: 1000,
      }),
    );
    // follow the host's incarnation-bound cursor, never infer completion from a missing tail entry.
    const cursors = new Set<string>();
    for (let page = 0; page < 20; page++) {
      if (history.sessionId !== caller.sessionId || !Array.isArray(history.messages)) break;
      if (issueTurnReply(history.messages, record.resultTurnId)) return;
      const cursor = history.newerCursor;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
      history = sessionObject(
        await request('chat.history', {
          sessionKey: caller.sessionKey,
          cursor,
          limit: 200,
          maxChars: 100000,
          toolResultMaxChars: 1000,
        }),
      );
    }
    throw new Error('dispatch-assessment-continuation-not-ready');
  }
}
