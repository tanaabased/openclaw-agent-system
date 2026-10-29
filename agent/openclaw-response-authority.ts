import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { nativeInputEvent } from './openclaw-session-input.ts';
import openClawTurnReply from './openclaw-turn-evidence.ts';
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
    if (
      await openClawTurnReply(request, caller, record.resultTurnId, {
        messageId: original.inputEventId,
      })
    )
      return;
    throw new Error('dispatch-assessment-continuation-not-ready');
  }
}
