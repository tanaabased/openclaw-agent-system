import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { describeIssueSession } from './openclaw-session-create.ts';
import { reconcileOpenClawTurn } from './openclaw-turn.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

export function openClawDecisionPending(record: OpenClawDispatchRecord) {
  return Boolean(
    record.decisionTurn &&
    record.decisionTurn.status !== 'completed' &&
    !record.decisionTurn.inactive,
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
  if (!record.decisionTurn || record.decisionTurn.status === 'completed')
    return { status: 'assessment-completed', id: record.id };
  await input.assertCurrent();
  await describeIssueSession(request, record, input.config, 'feedback');
  await reconcileOpenClawTurn({
    record,
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
