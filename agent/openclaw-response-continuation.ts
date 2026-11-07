import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { describeIssueSession } from './openclaw-session-create.ts';
import { reconcileOpenClawTurn } from './openclaw-turn.ts';

export function openClawResponsePending(record: OpenClawDispatchRecord) {
  const turn = record.summaryRecovery?.turn;
  return Boolean(turn && turn.status !== 'completed' && !turn.inactive);
}

export const openClawResponseEligible = openClawResponsePending;

/** Reconcile an old summary request without creating another conversation turn. */
export default async function continueOpenClawResponse(input: {
  record: OpenClawDispatchRecord;
  request: DispatchRequest;
  config: OpenClawConfig;
  assertCurrent(): Promise<void>;
  save(): Promise<void>;
}) {
  const { record, request } = input;
  const expected = record.request;
  const turn = record.summaryRecovery?.turn;
  if (!turn || !expected || !('key' in expected)) return;
  await input.assertCurrent();
  await describeIssueSession(request, record, input.config, 'feedback');
  await reconcileOpenClawTurn({
    request,
    sessionKey: expected.key,
    sessionId: record.sessionCreation!.sessionId!,
    turn,
    save: input.save,
  });
  return {
    status:
      turn.status === 'completed'
        ? ('assessment-completed' as const)
        : ('assessment-pending' as const),
    id: record.id,
  };
}
