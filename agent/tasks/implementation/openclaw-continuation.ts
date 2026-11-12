import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { DispatchRequest } from '../../../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from '../../openclaw-dispatch-state.ts';
import openClawNativeTurns from '../../openclaw-native-turns.ts';
import { describeIssueSession } from '../../openclaw-session-create.ts';
import type { OpenClawTurn } from '../../openclaw-turn-state.ts';
import { reconcileOpenClawTurn } from '../../openclaw-turn.ts';
import workflowFailure from '../../workflow-failure.ts';

/** Only an existing native request can need reconciliation; idle is never new work. */
export function openClawWorkSlot(record: OpenClawDispatchRecord) {
  if (record.nativeTurns?.some(({ turn }) => turn.status !== 'completed' && !turn.inactive))
    return 'native';
}

export default async function advanceOpenClawWork(input: {
  record: OpenClawDispatchRecord;
  request: DispatchRequest;
  config: OpenClawConfig;
  save(): Promise<void>;
  assertCurrent(): Promise<void>;
}) {
  const { record, request, save } = input;
  const slot = openClawWorkSlot(record);
  if (!slot) return { status: 'implementation-idle', id: record.id };
  const expected = record.request;
  if (!expected || !('key' in expected)) throw new Error('dispatch-session-intent-missing');
  await input.assertCurrent();
  await describeIssueSession(request, record, input.config, 'feedback');
  const outcomes = [];
  const turns = openClawNativeTurns(record).filter(({ role }) => role !== 'feedback');
  for (const { role: key, turn } of turns) {
    if (!turn || turn.status === 'completed' || turn.inactive) continue;
    try {
      await input.assertCurrent();
      await reconcileOpenClawTurn({
        record,
        request,
        sessionKey: expected.key,
        sessionId: record.sessionCreation!.sessionId!,
        turn: turn as OpenClawTurn,
        save,
      });
      outcomes.push({ key, status: turn.status });
    } catch (error) {
      outcomes.push({ key, ...workflowFailure(error, 'dispatch-turn-reconciliation-unavailable') });
    }
  }
  return { status: 'reconciled', id: record.id, outcomes };
}
