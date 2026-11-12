import type { ManagedIssue as IntakeRecord } from './managed-issue.ts';
import { assessmentTurnMessage } from './tasks/assessment/openclaw-assessment.ts';
import { nativeTurnFor } from './openclaw-native-turns.ts';
import type { OpenClawTurn } from './openclaw-turn-state.ts';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import deliverOpenClawTaskInput from './openclaw-task-input.ts';

import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { verifyEmptyIssueSession } from './openclaw-session-create.ts';

/** one persisted attempt; recovery reads exact input custody and transcript ownership, never resends. */
export default async function advanceIssueTurn(input: {
  credential: Pick<SessionDispatchCredential, 'use'>;
  record: OpenClawDispatchRecord;
  save(): Promise<void>;
  authority: DispatchAuthority;
  config: OpenClawConfig;
  presentation?: {
    intake: IntakeRecord;
    workspace: string;
    debug?: boolean;
  };
}) {
  const { record, save, authority } = input;
  const role = 'assessment';
  const currentTurn = () => nativeTurnFor(record, role);
  const expected = record.request;
  const sessionId = record.sessionCreation?.sessionId;
  if (
    !expected ||
    !('key' in expected) ||
    !record.sessionCreation?.verified ||
    !sessionId ||
    !record.context
  )
    throw new Error('dispatch-turn-session-unverified');
  const guard = async () => {
    authority.signal?.throwIfAborted();
    await authority.assertCurrent?.();
    authority.signal?.throwIfAborted();
  };
  await guard();
  return input.credential.use(authority, async (request) => {
    await deliverOpenClawTaskInput({
      record,
      turn: currentTurn() as OpenClawTurn | undefined,
      source: 'assignment',
      request,
      config: input.config,
      assertCurrent: guard,
      save,
      retain(turn) {
        (record.nativeTurns ??= []).push({ role, turn });
      },
      async prepare() {
        await verifyEmptyIssueSession(request, record, input.config, true);
        return {
          runId: `${record.id}:assessment`,
          message: assessmentTurnMessage(record, input.presentation),
          leaf: null,
        };
      },
    });
    const turn = currentTurn()! as OpenClawTurn;
    if (turn.status === 'completed') delete currentTurn()!.message;
    await guard();

    delete record.blocker;
    delete record.failureStage;
    await save();
    return {
      status: turn.status === 'completed' ? 'assessment-completed' : 'assessment-pending',
      id: record.id,
      sessionKey: expected.key,
      sessionId,
      runId: turn.runId,
      delivery: turn.status,
      replyEventId: turn.replyEventId,
      executionModel: turn.executionModel ?? 'unverified',
      executionEffort: 'unverified',
      configuredModel: record.effective?.model,
      configuredEffort: record.effective?.effort,
    };
  });
}
