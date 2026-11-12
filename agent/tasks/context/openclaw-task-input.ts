import { validateChatSendParams } from '@openclaw/gateway-protocol';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type { DispatchRequest } from '../../../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from '../dispatch/openclaw-dispatch-state.ts';
import { describeIssueSession, sessionObject } from '../../openclaw-session-create.ts';
import type { OpenClawTurn } from '../../openclaw-turn-state.ts';
import { reconcileOpenClawTurn } from '../../openclaw-turn.ts';
import deliverTaskInput from './task-input-delivery.ts';

export default async function deliverOpenClawTaskInput(input: {
  record: OpenClawDispatchRecord;
  turn: OpenClawTurn | undefined;
  source: 'assignment' | 'feedback';
  request: DispatchRequest;
  config: OpenClawConfig;
  prepare(): Promise<{ runId: string; message: string; leaf: string | null }>;
  retain(turn: OpenClawTurn): void;
  assertCurrent(): Promise<void>;
  save(): Promise<void>;
}) {
  const { record, request, save } = input;
  const expected = record.request;
  const sessionId = record.sessionCreation?.sessionId;
  if (!expected || !('key' in expected) || !record.sessionCreation?.verified || !sessionId)
    throw new Error('dispatch-turn-session-unverified');
  let params: Record<string, unknown>;
  return deliverTaskInput<OpenClawTurn>({
    attempt: input.turn,
    async prepare() {
      const prepared = await input.prepare();
      params = {
        sessionKey: expected.key,
        sessionId,
        agentId: expected.agentId,
        message: prepared.message,
        expectedLeafEntryId: prepared.leaf,
        idempotencyKey: prepared.runId,
        queueMode: 'followup',
        deliver: false,
      };
      if (!validateChatSendParams(params)) throw new Error('dispatch-turn-request-invalid');
      return { runId: prepared.runId, message: prepared.message, status: 'attempted' };
    },
    retain: input.retain,
    assertCurrent: input.assertCurrent,
    save,
    async send(turn) {
      const sent = sessionObject(await request('chat.send', params));
      if (sent.runId !== turn.runId || !['started', 'queued', 'ok'].includes(String(sent.status)))
        throw new Error('dispatch-turn-send-unverified');
      turn.status = 'accepted';
    },
    async reconcile(turn) {
      await describeIssueSession(
        request,
        record,
        input.config,
        input.source === 'feedback' ? 'feedback' : 'workflow',
      );
      await reconcileOpenClawTurn({
        record,
        request,
        sessionKey: expected.key,
        sessionId,
        turn,
        allowExecutionRunId: input.source === 'feedback',
        deliveryOnly: input.source === 'feedback',
        save,
      });
      return {
        status: turn.status === 'consumed' || turn.status === 'completed' ? 'delivered' : 'pending',
      };
    },
  });
}
