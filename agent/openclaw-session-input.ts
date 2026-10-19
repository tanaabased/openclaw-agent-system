import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { sessionObject } from './openclaw-session-create.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

/** native tool context establishes owner authority; history establishes exact input custody. */
export async function nativeInputEvent(input: {
  request: DispatchRequest;
  requireOwner?: boolean;
  sessionKey: string;
  sessionId: string;
  runId: string;
  retained: Array<{ runId: string; inputEventId: string } | undefined>;
}) {
  const { request, sessionKey, sessionId, runId } = input;
  const fail = (): never => {
    throw new Error(
      input.requireOwner ? 'dispatch-operator-input-unverified' : 'dispatch-input-unverified',
    );
  };
  const history = sessionObject(
    await request('chat.history', {
      sessionKey,
      inputRunIds: [runId],
      limit: 200,
      maxChars: 100000,
    }),
  );
  if (history.sessionId !== sessionId || !Array.isArray(history.messages)) fail();
  const receipts = Array.isArray(history.inputReceipts)
    ? history.inputReceipts.map(sessionObject).filter((entry) => entry.runId === runId)
    : [];
  if (receipts.length > 1) fail();
  const receipt = receipts[0];
  if (
    receipt &&
    (receipt.cancelled === true ||
      receipt.state !== 'consumed' ||
      typeof receipt.consumedByEventId !== 'string' ||
      !receipt.consumedByEventId)
  )
    fail();
  const anchors = input.retained
    .filter((entry) => entry?.runId === runId)
    .map((entry) => entry!.inputEventId);
  if (receipt) anchors.push(receipt.consumedByEventId as string);
  const candidates = (history.messages as unknown[]).map(sessionObject).filter((entry) => {
    const meta = sessionObject(entry.__openclaw);
    return (
      entry.role === 'user' &&
      (meta.runId === runId ||
        meta.idempotencyKey === `${runId}:user` ||
        entry.idempotencyKey === `${runId}:user`)
    );
  });
  if (candidates.length > 1) fail();
  if (candidates.length) {
    const id = issueInputEventId(candidates[0]!, runId);
    if (
      !id ||
      (input.requireOwner && sessionObject(candidates[0]!.__openclaw).senderIsOwner === false)
    )
      fail();
    anchors.push(id!);
  }
  if (!anchors.length || anchors.some((id) => !id || id !== anchors[0])) fail();
  const inputEventId = anchors[0]!;
  // anchor to the session incarnation, never a similarly named replacement session.
  const exact = sessionObject(
    await request('chat.history', {
      sessionKey,
      sessionId,
      messageId: inputEventId,
      limit: 1,
      maxChars: 100000,
    }),
  );
  if (exact.sessionId !== sessionId || !Array.isArray(exact.messages)) fail();
  const matches = (exact.messages as unknown[]).map(sessionObject).filter((entry) => {
    const meta = sessionObject(entry.__openclaw);
    return (
      meta.id === inputEventId ||
      (entry.role === 'user' &&
        (meta.runId === runId ||
          meta.idempotencyKey === `${runId}:user` ||
          entry.idempotencyKey === `${runId}:user`))
    );
  });
  if (matches.length !== 1) fail();
  const entry = matches[0]!;
  if (
    issueInputEventId(entry, runId) !== inputEventId ||
    (input.requireOwner && sessionObject(entry.__openclaw).senderIsOwner === false)
  )
    fail();
  return {
    runId,
    inputEventId,
    message: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
  };
}

/** owner verification is needed only when human direction supplies the transition. */
export async function operatorInputEvent(
  input: Omit<Parameters<typeof nativeInputEvent>[0], 'requireOwner'> & { senderIsOwner: boolean },
) {
  if (!input.senderIsOwner) throw new Error('dispatch-operator-input-unverified');
  const { runId, inputEventId } = await nativeInputEvent({ ...input, requireOwner: true });
  return { runId, inputEventId };
}

/** user input custody is journaled by idempotency key; run metadata is optional. */
export function issueInputEventId(entry: Record<string, unknown>, runId: string) {
  const key = `${runId}:user`;
  const meta = sessionObject(entry.__openclaw);
  if (
    entry.role !== 'user' ||
    (meta.runId !== undefined && meta.runId !== runId) ||
    typeof meta.id !== 'string' ||
    !meta.id ||
    meta.truncated === true ||
    (meta.idempotencyKey ?? entry.idempotencyKey) !== key ||
    (entry.idempotencyKey !== undefined && entry.idempotencyKey !== key)
  )
    return;
  return meta.id;
}

/** verify exact journaled input before either reconciliation or assessment adopts its identity. */
export default function issueInputEvent(
  entry: Record<string, unknown>,
  turn: Pick<NonNullable<OpenClawDispatchRecord['assessmentTurn']>, 'runId' | 'message'>,
) {
  const content =
    typeof entry.content === 'string'
      ? entry.content
      : Array.isArray(entry.content) &&
          entry.content.every((block) => {
            const part = sessionObject(block);
            return part.type === 'text' && typeof part.text === 'string';
          })
        ? entry.content.map((block) => sessionObject(block).text).join('')
        : undefined;
  if (content !== turn.message) return;
  return issueInputEventId(entry, turn.runId);
}
