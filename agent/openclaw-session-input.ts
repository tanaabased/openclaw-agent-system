import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import { completeOpenClawMessage, openClawHistoryPages } from './openclaw-history.ts';
import { sessionObject } from './openclaw-session-create.ts';
import { workflowFailureStep } from './tasks/workflow-failure.ts';

// Native chat history projects sessions_send inputs as assistant messages; labels are not evidence.
function isForwardedInput(entry: Record<string, unknown>) {
  const provenance = entry.provenance;
  return Boolean(
    provenance &&
    typeof provenance === 'object' &&
    !Array.isArray(provenance) &&
    'kind' in provenance &&
    provenance.kind === 'inter_session' &&
    'sourceTool' in provenance &&
    provenance.sourceTool === 'sessions_send',
  );
}

function isNativeInput(entry: Record<string, unknown>) {
  return entry.role === 'user' || (entry.role === 'assistant' && isForwardedInput(entry));
}

/** native tool context establishes owner authority; history establishes exact input custody. */
export function nativeInputEvent(input: Parameters<typeof readNativeInputEvent>[0]) {
  return workflowFailureStep('input-verification', () => readNativeInputEvent(input));
}

async function readNativeInputEvent(input: {
  request: DispatchRequest;
  requireOwner?: boolean;
  sessionKey: string;
  sessionId: string;
  runId: string;
  inputId?: string;
  retained: Array<{ runId: string; inputEventId: string } | undefined>;
}) {
  const { request, sessionKey, sessionId, runId } = input;
  const fail = (inputVerificationReason = 'input-identity-conflict'): never => {
    throw Object.assign(
      new Error(
        input.requireOwner ? 'dispatch-operator-input-unverified' : 'dispatch-input-unverified',
      ),
      { inputVerificationReason },
    );
  };
  // Prompt hooks may bind a submission key; history anchors accept only event IDs.
  const boundInputKey = input.inputId?.endsWith(':user') ? input.inputId : undefined;
  if (boundInputKey && boundInputKey.length <= 5) fail('bound-input-missing');
  const boundHistory =
    input.inputId && !boundInputKey
      ? sessionObject(
          await request('chat.history', {
            sessionKey,
            sessionId,
            messageId: input.inputId,
            limit: 1,
          }),
        )
      : undefined;
  if (
    boundHistory &&
    (boundHistory.sessionId !== sessionId || !Array.isArray(boundHistory.messages))
  )
    fail('session-evidence-mismatch');
  const boundEntries = (boundHistory?.messages as unknown[] | undefined)
    ?.map(sessionObject)
    .filter((entry) => {
      const meta = sessionObject(entry.__openclaw);
      return (
        meta.id === input.inputId || (meta.idempotencyKey ?? entry.idempotencyKey) === input.inputId
      );
    });
  if (boundEntries && boundEntries.length !== 1) fail('bound-input-missing-or-duplicate');
  const boundEntry = boundEntries?.[0];
  const boundKey =
    boundEntry &&
    (sessionObject(boundEntry.__openclaw).idempotencyKey ?? boundEntry.idempotencyKey);
  if (
    boundEntry &&
    (typeof boundKey !== 'string' || !boundKey.endsWith(':user') || boundKey.length <= 5)
  )
    fail();
  const inputRunId =
    (boundInputKey ?? (typeof boundKey === 'string' ? boundKey : undefined))?.slice(0, -5) ?? runId;
  const boundEventId =
    boundEntry &&
    issueInputEventId(await completeOpenClawMessage(request, input, boundEntry), inputRunId, runId);
  if (boundEntry && !boundEventId) fail();
  const history = sessionObject(
    await request('chat.history', {
      sessionKey,
      inputRunIds: [inputRunId],
    }),
  );
  if (history.sessionId !== sessionId || !Array.isArray(history.messages))
    fail('session-evidence-mismatch');
  const receipts = Array.isArray(history.inputReceipts)
    ? history.inputReceipts.map(sessionObject).filter((entry) => entry.runId === inputRunId)
    : [];
  if (receipts.length > 1) fail('input-receipt-conflict');
  const receipt = receipts[0];
  if (
    receipt &&
    (receipt.cancelled === true ||
      receipt.state !== 'consumed' ||
      typeof receipt.consumedByEventId !== 'string' ||
      !receipt.consumedByEventId)
  )
    fail('input-receipt-invalid-or-cancelled');
  const anchors = boundEventId
    ? [boundEventId]
    : input.inputId
      ? []
      : input.retained
          .filter((entry) => entry?.runId === runId)
          .map((entry) => entry!.inputEventId);
  if (receipt) anchors.push(receipt.consumedByEventId as string);
  for await (const messages of openClawHistoryPages(request, input, { first: history })) {
    if (boundEventId) break;
    const candidates = messages.filter((entry) => {
      const meta = sessionObject(entry.__openclaw);
      return (
        isNativeInput(entry) &&
        ((!boundInputKey && meta.runId === runId) ||
          meta.idempotencyKey === `${inputRunId}:user` ||
          entry.idempotencyKey === `${inputRunId}:user`)
      );
    });
    if (candidates.length > 1) fail();
    if (candidates.length) {
      const candidate = await completeOpenClawMessage(request, input, candidates[0]!);
      const id = issueInputEventId(candidate, inputRunId, runId);
      if (
        !id ||
        (input.requireOwner &&
          (isForwardedInput(candidate) ||
            sessionObject(candidate.__openclaw).senderIsOwner === false))
      )
        fail();
      anchors.push(id!);
    }
    // a native consumption receipt or retained exact identity avoids unrelated history reads.
    if (anchors.length) break;
  }
  if (!anchors.length) fail('bound-input-missing');
  if (anchors.some((id) => !id || id !== anchors[0])) fail('input-identity-conflict');
  const inputEventId = anchors[0]!;
  // anchor to the session incarnation, never a similarly named replacement session.
  const exact =
    boundHistory ??
    sessionObject(
      await request('chat.history', {
        sessionKey,
        sessionId,
        messageId: inputEventId,
        limit: 1,
      }),
    );
  if (exact.sessionId !== sessionId || !Array.isArray(exact.messages))
    fail('session-evidence-mismatch');
  const matches = (exact.messages as unknown[]).map(sessionObject).filter((entry) => {
    const meta = sessionObject(entry.__openclaw);
    return (
      meta.id === inputEventId ||
      (!input.inputId &&
        isNativeInput(entry) &&
        (meta.runId === runId ||
          meta.idempotencyKey === `${runId}:user` ||
          entry.idempotencyKey === `${runId}:user`))
    );
  });
  if (matches.length !== 1) fail('bound-input-missing-or-duplicate');
  const entry = await completeOpenClawMessage(request, input, matches[0]!);
  if (issueInputEventId(entry, inputRunId, runId) !== inputEventId) fail();
  if (
    input.requireOwner &&
    (isForwardedInput(entry) || sessionObject(entry.__openclaw).senderIsOwner === false)
  )
    fail('input-owner-unverified');
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
  return nativeInputEvent({ ...input, requireOwner: true });
}

/** user input custody is journaled by idempotency key; run metadata is optional. */
export function issueInputEventId(
  entry: Record<string, unknown>,
  runId: string,
  executionRunId = runId,
) {
  const key = `${runId}:user`;
  const meta = sessionObject(entry.__openclaw);
  if (
    !isNativeInput(entry) ||
    (meta.runId !== undefined && meta.runId !== executionRunId) ||
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
  turn: { runId: string; message?: string },
  executionRunId = turn.runId,
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
  return issueInputEventId(entry, turn.runId, executionRunId);
}
