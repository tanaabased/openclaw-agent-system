import sendOpenClawTurn from './openclaw-send-turn.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { needsAutoDecision, autoDecisionInstructions } from './auto-decision.ts';
import { feedbackSession } from './openclaw-feedback.ts';
import { describeIssueSession } from './openclaw-session-create.ts';
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
  if (record.decisionTurn?.inactive) return false;
  return (
    (record.decisionTurn && record.decisionTurn!.status !== 'completed') ||
    needsAutoDecision(record, mode)
  );
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
  if (!record.decisionTurn || record.decisionTurn!.status === 'completed') {
    const session = await feedbackSession(request, record, input.config);
    if (session.busy) return { status: 'assessment-pending', id: record.id, nextAction: 'next' };
    if (typeof session.leaf !== 'string' || !session.leaf)
      throw new Error('dispatch-assessment-history-unverified');
    if (record.decisionTurn) {
      (record.previousDecisionTurns ??= []).push(record.decisionTurn);
      delete record.decisionTurn;
    }
    const resumed = record.previousDecisionTurns?.length ?? 0;
    const runId = `${record.id}:auto-decision${resumed ? ':resume:' + resumed : ''}`;
    const message =
      (resumed ? 'Resume the unfinished Auto decision. ' : '') +
      autoDecisionInstructions +
      ` Refresh agent_system_dispatch action context with id ${record.id}, then submit action result in this same session.`;
    await sendOpenClawTurn({
      request,
      params: {
        sessionKey: expected.key,
        agentId: expected.agentId,
        sessionId: record.sessionCreation!.sessionId!,
        message,
        expectedLeafEntryId: session.leaf,
        idempotencyKey: runId,
      },
      assertCurrent: input.assertCurrent,
      recordAttempt() {
        record.decisionTurn = { runId, message, status: 'attempted' };
      },
      recordAcceptance() {
        record.decisionTurn!.status = 'accepted';
      },
      save,
    });
  }
  await describeIssueSession(request, record, input.config);
  await reconcileOpenClawTurn({
    request,
    sessionKey: expected.key,
    sessionId: record.sessionCreation!.sessionId!,
    turn: record.decisionTurn!,
    save,
  });
  await save();
  return {
    status: ['completed'].includes(record.decisionTurn!.status)
      ? 'assessment-completed'
      : 'assessment-pending',
    id: record.id,
    nextAction: 'next',
  };
}
