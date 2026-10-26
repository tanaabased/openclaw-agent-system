import issueWorkflowProgress from './issue-workflow-progress.ts';
import sendOpenClawTurn from './openclaw-send-turn.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { feedbackSession } from './openclaw-feedback.ts';
import { reconcileOpenClawTurn } from './openclaw-turn.ts';
import pendingPublicResponse from './pending-public-response.ts';

export function openClawResponsePending(record: OpenClawDispatchRecord) {
  if (
    record.retired ||
    record.retirement ||
    record.reset ||
    record.result?.outcome === 'operator-setup-blocker'
  )
    return false;
  if (
    record.summaryRecovery &&
    !/denied|cancelled|mismatch/.test(record.summaryRecovery.code ?? '') &&
    record.summaryRecovery!.turn.status !== 'completed'
  )
    return true;
  if (
    record.assessmentTurn?.status !== 'completed' ||
    (record.decisionTurn && record.decisionTurn.status !== 'completed')
  )
    return false;
  const pending = pendingPublicResponse(record);
  if (!pending || record.blocker || pending.state === 'blocked' || record.summaryRecovery?.code)
    return false;
  return (
    !record.summaryRecovery ||
    record.summaryRecovery.revision !== pending.revision ||
    record.summaryRecovery!.turn.status !== 'completed'
  );
}

export function openClawResponseEligible(record: OpenClawDispatchRecord) {
  return (
    openClawResponsePending(record) &&
    ((!record.work && !record.handoff) ||
      issueWorkflowProgress(record).action === 'complete' ||
      (record.summaryRecovery && record.summaryRecovery!.turn.status !== 'completed'))
  );
}

/** reuse the native issue queue; never compose or publish from the coordinator. */
export default async function continueOpenClawResponse(input: {
  record: OpenClawDispatchRecord;
  request: DispatchRequest;
  config: OpenClawConfig;
  reconcileOnly?: boolean;
  assertCurrent(): Promise<void>;
  save(): Promise<void>;
}) {
  const { record, request } = input;
  const pending = pendingPublicResponse(record);
  if (pending?.state === 'blocked') return;
  const expected = record.request;
  if (!expected || !('key' in expected)) return;
  if (record.summaryRecovery) {
    await reconcileOpenClawTurn({
      request,
      sessionKey: expected.key,
      sessionId: record.sessionCreation!.sessionId!,
      turn: record.summaryRecovery.turn,
      save: input.save,
    });
    delete record.summaryRecovery.code;
    await input.save();
    if (
      !pending ||
      record.summaryRecovery.revision === pending.revision ||
      record.summaryRecovery!.turn.status !== 'completed'
    )
      return {
        status:
          record.summaryRecovery!.turn.status === 'completed'
            ? ('assessment-completed' as const)
            : ('assessment-pending' as const),
        id: record.id,
      };
  }
  if (!pending || !pending.revision) return;
  if (input.reconcileOnly) return { status: 'assessment-pending' as const, id: record.id };
  const session = await feedbackSession(request, record, input.config);
  if (session.busy) return { status: 'assessment-pending' as const, id: record.id };
  if (typeof session.leaf !== 'string' || !session.leaf)
    throw new Error('feedback-session-unverified');
  const runId = `${record.id}:summary:${pending.revision}`;
  const message = `Agent System: recover only the pending public assessment summary in this existing issue chat. The private assessment is already saved; do not repeat assessment or implementation. Call agent_system_dispatch action summary, id ${record.id}, operation ${pending.summary?.attempt ? 'reconcile' : 'compose'}. Follow its verified composition/publication instructions and present the full retained private result with its public outcome. Preserve current user direction, native denial and cancellation. Never repost an uncertain write or create a replacement issue or PR.`;
  await sendOpenClawTurn({
    request,
    params: {
      sessionKey: expected.key,
      sessionId: record.sessionCreation!.sessionId!,
      agentId: expected.agentId,
      message,
      expectedLeafEntryId: session.leaf,
      idempotencyKey: runId,
    },
    assertCurrent: input.assertCurrent,
    recordAttempt() {
      if (record.summaryRecovery)
        (record.previousSummaryTurns ??= []).push({
          revision: record.summaryRecovery.revision,
          turn: record.summaryRecovery.turn,
        });
      record.summaryRecovery = {
        revision: pending.revision!,
        turn: { runId, message, status: 'attempted' },
      };
    },
    recordAcceptance() {
      record.summaryRecovery!.turn.status = 'accepted';
    },
    save: input.save,
  });
  return { status: 'assessment-pending' as const, id: record.id };
}
