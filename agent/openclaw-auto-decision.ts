import { validateChatSendParams } from '@openclaw/gateway-protocol';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { needsAutoDecision, autoDecisionInstructions } from './auto-decision.ts';
import { feedbackSession } from './openclaw-feedback.ts';
import { describeIssueSession, sessionObject } from './openclaw-session-create.ts';
import { reconcileOpenClawTurn } from './openclaw-turn.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

export function openClawDecisionPending(record: OpenClawDispatchRecord, mode: string) {
  if (
    record.retired ||
    record.retirement ||
    record.reset ||
    record.handoff ||
    !record.sessionCreation?.verified ||
    record.assessmentTurn?.status !== 'completed'
  )
    return false;
  return record.decisionTurn
    ? record.decisionTurn.status !== 'completed' && !record.decisionTurn.inactive
    : needsAutoDecision(record, mode);
}

/** use the assessment's existing context/result contract and preserve its original receipt. */
export default async function advanceOpenClawDecision(input: {
  record: OpenClawDispatchRecord;
  request: DispatchRequest;
  config: OpenClawConfig;
  save(): Promise<void>;
  assertCurrent(): Promise<void>;
}) {
  const { record, request, save } = input;
  const expected = record.request;
  if (!expected || !('key' in expected)) throw new Error('dispatch-session-intent-missing');
  if (!record.decisionTurn) {
    const session = await feedbackSession(request, record, input.config);
    if (session.busy) return { status: 'assessment-pending', id: record.id, nextAction: 'next' };
    if (typeof session.leaf !== 'string' || !session.leaf)
      throw new Error('dispatch-assessment-history-unverified');
    const runId = `${record.id}:auto-decision`;
    const message =
      autoDecisionInstructions +
      ` Refresh agent_system_dispatch action context with id ${record.id}, then submit action result in this same session.`;
    const params = {
      sessionKey: expected.key,
      agentId: expected.agentId,
      sessionId: record.sessionCreation!.sessionId!,
      message,
      queueMode: 'followup',
      deliver: false,
      expectedLeafEntryId: session.leaf,
      idempotencyKey: runId,
    };
    if (!validateChatSendParams(params)) throw new Error('dispatch-turn-request-invalid');
    await input.assertCurrent();
    record.decisionTurn = { runId, message, status: 'attempted' };
    await save();
    await input.assertCurrent();
    const sent = sessionObject(await request('chat.send', params));
    if (sent.runId !== runId || !['started', 'queued', 'ok'].includes(String(sent.status)))
      throw new Error('dispatch-turn-send-unverified');
    record.decisionTurn.status = 'accepted';
    await save();
  }
  await describeIssueSession(request, record, input.config);
  await reconcileOpenClawTurn({
    request,
    sessionKey: expected.key,
    sessionId: record.sessionCreation!.sessionId!,
    model: expected.model,
    turn: record.decisionTurn,
    save,
  });
  await save();
  return {
    status:
      record.decisionTurn.status === 'completed' ? 'assessment-completed' : 'assessment-pending',
    id: record.id,
    nextAction: 'next',
  };
}
