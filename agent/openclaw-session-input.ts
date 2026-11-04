import { completeOpenClawMessage, openClawHistoryPages } from './openclaw-history.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { sessionObject } from './openclaw-session-create.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import { nativeObject } from './automation-gateway.ts';

/** native tool context establishes owner authority; history establishes exact input custody. */
async function readNativeInputEvent(
  input: {
    request: DispatchRequest;
    sessionKey: string;
    sessionId: string;
    runId: string;
    retained: Array<{ runId: string; inputEventId: string } | undefined>;
  },
  operator = false,
) {
  const { request, sessionKey, sessionId, runId } = input;
  const fail = (): never => {
    throw new Error(operator ? 'dispatch-operator-input-unverified' : 'dispatch-input-unverified');
  };
  const history = sessionObject(
    await request('chat.history', {
      sessionKey,
      inputRunIds: [runId],
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
  for await (const messages of openClawHistoryPages(request, input, { first: history })) {
    const candidates = messages.filter((entry) => {
      const meta = sessionObject(entry.__openclaw);
      return (
        isNativeInput(entry) &&
        (meta.runId === runId ||
          meta.idempotencyKey === `${runId}:user` ||
          entry.idempotencyKey === `${runId}:user`)
      );
    });
    if (candidates.length > 1) fail();
    if (candidates.length) {
      const candidate = await completeOpenClawMessage(request, input, candidates[0]!);
      const id = issueInputEventId(candidate, runId);
      if (!id) fail();
      anchors.push(id!);
    }
    // a native consumption receipt or retained exact identity avoids unrelated history reads.
    if (anchors.length) break;
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
    }),
  );
  if (exact.sessionId !== sessionId || !Array.isArray(exact.messages)) fail();
  const matches = (exact.messages as unknown[]).map(sessionObject).filter((entry) => {
    const meta = sessionObject(entry.__openclaw);
    return (
      meta.id === inputEventId ||
      (isNativeInput(entry) &&
        (meta.runId === runId ||
          meta.idempotencyKey === `${runId}:user` ||
          entry.idempotencyKey === `${runId}:user`))
    );
  });
  if (matches.length !== 1) fail();
  const entry = await completeOpenClawMessage(request, input, matches[0]!);
  if (issueInputEventId(entry, runId) !== inputEventId) fail();
  return {
    runId,
    inputEventId,
    message: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
    entry,
  };
}

export async function nativeInputEvent(input: Parameters<typeof readNativeInputEvent>[0]) {
  const { runId, inputEventId, message } = await readNativeInputEvent(input);
  return { runId, inputEventId, message };
}

/** Scheduled/local input keeps its existing path; a handoff returns verified source context. */
export async function delegatedOperatorInput(input: Parameters<typeof nativeInputEvent>[0]) {
  const read = await readNativeInputEvent(input);
  if (!nativeObject(read.entry.provenance) || read.entry.provenance.kind !== 'inter_session')
    return undefined;
  return verifyOperatorInput(input, read, false, new Set());
}

/** owner verification is needed only when human direction supplies the transition. */
export async function operatorInputEvent(
  input: Parameters<typeof nativeInputEvent>[0] & { senderIsOwner: boolean },
) {
  return verifyOperatorInput(
    input,
    await readNativeInputEvent(input, true),
    input.senderIsOwner,
    new Set(),
  );
}

async function verifyOperatorInput(
  input: Parameters<typeof nativeInputEvent>[0],
  { entry, ...source }: Awaited<ReturnType<typeof readNativeInputEvent>>,
  senderIsOwner: boolean,
  ancestors: Set<string>,
): Promise<{ runId: string; inputEventId: string; message: string }> {
  const provenance = entry.provenance;
  if (nativeObject(provenance) && provenance.kind === 'inter_session')
    return { ...source, message: await delegatedOpenClawInput(input, entry, ancestors) };
  const owner = sessionObject(entry.__openclaw).senderIsOwner;
  if (
    (nativeObject(provenance) && provenance.kind !== 'external_user') ||
    (!senderIsOwner && !(ancestors.size > 0 && owner === true)) ||
    owner === false
  )
    throw new Error('dispatch-operator-input-unverified');
  return source;
}

/** OpenClaw displays inter-session user inputs as assistant messages, retaining native provenance. */
function isNativeInput(entry: Record<string, unknown>) {
  return (
    entry.role === 'user' ||
    (entry.role === 'assistant' &&
      nativeObject(entry.provenance) &&
      entry.provenance.kind === 'inter_session' &&
      entry.provenance.sourceTool === 'sessions_send')
  );
}

/** user input custody is journaled by idempotency key; run metadata is optional. */
export function issueInputEventId(entry: Record<string, unknown>, runId: string) {
  const key = `${runId}:user`;
  const meta = sessionObject(entry.__openclaw);
  if (
    !isNativeInput(entry) ||
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

/** Native provenance and the exact sender tool result bind an inter-session input to its owner. */
async function delegatedOpenClawInput(
  input: Parameters<typeof nativeInputEvent>[0],
  entry: Record<string, unknown>,
  ancestors: Set<string>,
): Promise<string> {
  const fail = (): never => {
    throw new Error('dispatch-operator-input-unverified');
  };
  const provenance = entry.provenance;
  if (
    !nativeObject(provenance) ||
    provenance.kind !== 'inter_session' ||
    provenance.sourceTool !== 'sessions_send' ||
    typeof provenance.sourceSessionKey !== 'string' ||
    !provenance.sourceSessionKey ||
    provenance.sourceSessionKey === input.sessionKey
  )
    return fail();
  const key = `${input.sessionId}:${input.runId}`;
  if (ancestors.has(key)) return fail();
  ancestors.add(key);
  const sessionKey = provenance.sourceSessionKey;
  const first = sessionObject(await input.request('chat.history', { sessionKey }));
  if (typeof first.sessionId !== 'string' || !first.sessionId) return fail();
  const scope = { sessionKey, sessionId: first.sessionId };
  const messages: Record<string, unknown>[] = [];
  for await (const page of openClawHistoryPages(input.request, scope, { first }))
    messages.unshift(...page);
  const text = (value: unknown): string | undefined =>
    typeof value === 'string'
      ? value
      : Array.isArray(value) &&
          value.every(
            (part) => nativeObject(part) && part.type === 'text' && typeof part.text === 'string',
          )
        ? value.map((part) => part.text).join('')
        : undefined;
  // History is a display projection. Restore candidate messages before inspecting their payloads.
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (
      message.role === 'assistant' ||
      (message.role === 'toolResult' && message.toolName === 'sessions_send')
    )
      messages[index] = await completeOpenClawMessage(input.request, scope, message);
  }
  const results = messages.flatMap((message) => {
    if (message.role !== 'toolResult' || message.toolName !== 'sessions_send') return [];
    // Native jsonResult content survives projection; details deliberately omits runId/status.
    let details: unknown;
    try {
      details = JSON.parse(text(message.content) ?? '');
    } catch {
      return [];
    }
    return nativeObject(details) && details.runId === input.runId ? [{ message, details }] : [];
  });
  if (results.length > 1) return fail();
  const result = results[0];
  if (
    result &&
    (result.message.isError === true ||
      !['accepted', 'ok'].includes(String(result.details.status)) ||
      typeof result.message.toolCallId !== 'string')
  )
    return fail();
  const calls = messages.filter(
    (message) =>
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          nativeObject(part) &&
          part.type === 'toolCall' &&
          part.name === 'sessions_send' &&
          (result
            ? part.id === result.message.toolCallId
            : typeof message.timestamp === 'number' &&
              typeof entry.timestamp === 'number' &&
              message.timestamp <= entry.timestamp &&
              nativeObject(part.arguments) &&
              part.arguments.sessionKey === input.sessionKey &&
              typeof part.arguments.message === 'string' &&
              part.arguments.message === text(entry.content)),
      ),
  );
  if (calls.length !== 1) return fail();
  const call = calls[0]!;
  if (
    !result &&
    messages.some(
      (message) =>
        message.role === 'toolResult' &&
        (call.content as Record<string, unknown>[]).some(
          (part) => part.name === 'sessions_send' && part.id === message.toolCallId,
        ),
    )
  )
    return fail();
  const runId = sessionObject(call.__openclaw).runId;
  if (typeof runId !== 'string' || !runId) return fail();
  for (let index = 0; index < messages.length; index++) {
    if (sessionObject(messages[index]!.__openclaw).runId === runId)
      messages[index] = await completeOpenClawMessage(input.request, scope, messages[index]!);
  }
  if (
    messages.some(
      (message) =>
        nativeObject(message.__openclaw) &&
        message.__openclaw.runId === runId &&
        (message.stopReason === 'aborted' ||
          (message.role === 'toolResult' &&
            nativeObject(message.details) &&
            (message.details.status === 'denied' ||
              message.details.approvalReviewOutcome === 'denied'))),
    )
  )
    return fail();
  const observed = sessionObject(await input.request('agent.wait', { runId, timeoutMs: 0 }));
  if (
    observed.runId !== runId ||
    !['ok', 'error', 'timeout'].includes(String(observed.status)) ||
    observed.stopReason === 'aborted' ||
    /denied|rejected/u.test(String(observed.code ?? ''))
  )
    return fail();
  // Historical owner metadata is required here; a helper cannot assert the parent's owner bit.
  const parentInput = { request: input.request, ...scope, runId, retained: [] };
  const origin = await verifyOperatorInput(
    parentInput,
    await readNativeInputEvent(parentInput, true),
    false,
    ancestors,
  );
  return JSON.stringify({ originatingInput: origin.message, delegatedInput: entry.content });
}
