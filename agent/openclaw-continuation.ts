import openClawNativeTurns from './openclaw-native-turns.ts';
import type { OpenClawTurn } from './openclaw-turn-state.ts';
import workflowFailure from './workflow-failure.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { describeIssueSession } from './openclaw-session-create.ts';
import { reconcileOpenClawTurn } from './openclaw-turn.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

/** Only an existing native request can need reconciliation; idle is never new work. */
export function openClawWorkSlot(record: OpenClawDispatchRecord) {
  if (record.nativeTurns?.some(({ turn }) => turn.status !== 'completed' && !turn.inactive))
    return 'native';
  for (const slot of ['turn', 'deliveryTurn'] as const) {
    const turn = record.work?.[slot];
    if (turn && turn.status !== 'completed' && !turn.inactive) return slot;
  }
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
  const turns = record.nativeRecord
    ? openClawNativeTurns(record).filter(({ role }) => role !== 'feedback')
    : (['turn', 'deliveryTurn'] as const).flatMap((key) =>
        record.work?.[key] ? [{ role: key, turn: record.work[key]! }] : [],
      );
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
