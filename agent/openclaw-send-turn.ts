import { validateChatSendParams } from '@openclaw/gateway-protocol';
import { sessionObject } from './openclaw-session-create.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

/** Persist one attempt before sending; an uncertain response is reconciled by the owner. */
export default async function sendOpenClawTurn(input: {
  request: DispatchRequest;
  params: {
    sessionKey: string;
    sessionId: string;
    agentId: string;
    message: string;
    expectedLeafEntryId: string | null;
    idempotencyKey: string;
  };
  assertCurrent(): Promise<void>;
  recordAttempt(): void;
  recordAcceptance(): void;
  save(): Promise<void>;
}) {
  const params = { ...input.params, queueMode: 'followup', deliver: false };
  if (!validateChatSendParams(params)) throw new Error('dispatch-turn-request-invalid');
  await input.assertCurrent();
  input.recordAttempt();
  await input.save();
  await input.assertCurrent();
  const sent = sessionObject(await input.request('chat.send', params));
  if (
    sent.runId !== params.idempotencyKey ||
    !['started', 'queued', 'ok'].includes(String(sent.status))
  )
    throw new Error('dispatch-turn-send-unverified');
  input.recordAcceptance();
  await input.save();
}
