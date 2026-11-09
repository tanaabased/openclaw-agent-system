import issueInputEvent, { issueInputEventId } from './openclaw-session-input.ts';
import openClawTurnReply from './openclaw-turn-evidence.ts';
import {
  completeOpenClawMessage,
  openClawHistoryPages,
  type HistoryScope,
} from './openclaw-history.ts';
import { sessionObject } from './openclaw-session-create.ts';
import type { OpenClawTurn } from './openclaw-turn-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

type FeedbackReselection = { runId: string; inputEventId: string };
/** ordinary consumed inputs leave the pending table; verify their exact transcript identity. */
export function consumedInputEvent(
  messages: unknown[],
  turn: OpenClawTurn,
  allowExecutionRunId = false,
  reselection?: FeedbackReselection,
) {
  const key = `${turn.runId}:user`;
  const inputs = messages.map(sessionObject).filter((entry) => {
    const meta = entry.__openclaw ? sessionObject(entry.__openclaw) : {};
    return (
      entry.role === 'user' &&
      (meta.runId === turn.runId || meta.idempotencyKey === key || entry.idempotencyKey === key)
    );
  });
  // retained verified consumption survives transcript tail pagination.
  if (!inputs.length && turn.consumedByEventId) return turn.consumedByEventId;
  if (inputs.length !== 1) throw new Error('dispatch-turn-delivery-unverified');
  const entry = inputs[0]!;
  const meta = sessionObject(entry.__openclaw);
  // queued delivery custody and the execution consuming it are distinct native identities.
  const executionRunId = allowExecutionRunId
    ? typeof meta.runId === 'string' && meta.runId
      ? meta.runId
      : (turn.executionRunId ?? turn.runId)
    : turn.runId;
  const eventId =
    turn.origin === 'assessment' || turn.origin === 'input'
      ? issueInputEventId(entry, turn.runId)
      : issueInputEvent(entry, turn, executionRunId);
  if (!eventId || (turn.consumedByEventId && turn.consumedByEventId !== eventId))
    throw new Error('dispatch-turn-input-mismatch');
  // older feedback selection copied the responder into this consumption hint.
  // repair only that exact selection, after native source and input verification.
  const responderHint =
    allowExecutionRunId &&
    typeof meta.runId === 'string' &&
    reselection?.runId === turn.executionRunId &&
    reselection?.inputEventId === turn.consumedByEventId &&
    reselection?.inputEventId === eventId;
  if (turn.executionRunId && turn.executionRunId !== executionRunId && !responderHint)
    throw new Error('dispatch-turn-run-mismatch');
  if (executionRunId !== turn.runId) turn.executionRunId = executionRunId;
  else if (responderHint) delete turn.executionRunId;
  return eventId;
}

/** recover missing or shortened input without replacing retained consumption. */
export async function openClawConsumedInput(
  request: DispatchRequest,
  scope: HistoryScope,
  turn: OpenClawTurn,
  first: Record<string, unknown>,
  allowExecutionRunId = false,
  reselection?: FeedbackReselection,
) {
  const receipts =
    allowExecutionRunId && Array.isArray(first.inputReceipts)
      ? first.inputReceipts.map(sessionObject).filter((entry) => entry.runId === turn.runId)
      : [];
  if (receipts.length > 1) throw new Error('dispatch-turn-receipt-invalid');
  const receipt = receipts[0];
  if (receipt?.cancelled === true) throw new Error('dispatch-turn-cancelled');
  const anchor = receipt?.state === 'consumed' ? receipt.consumedByEventId : undefined;
  if (receipt && (receipt.state !== 'consumed' || typeof anchor !== 'string' || !anchor))
    throw new Error('dispatch-turn-delivery-unverified');
  if (anchor && turn.consumedByEventId && anchor !== turn.consumedByEventId)
    throw new Error('dispatch-turn-input-mismatch');
  if (typeof anchor === 'string' && anchor) {
    const exact = sessionObject(
      await request('chat.history', {
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        messageId: anchor,
        limit: 1,
      }),
    );
    if (exact.sessionId !== scope.sessionId || !Array.isArray(exact.messages))
      throw new Error('dispatch-turn-history-unverified');
    const matches = exact.messages
      .map(sessionObject)
      .filter((entry) => sessionObject(entry.__openclaw).id === anchor);
    if (matches.length !== 1) throw new Error('dispatch-turn-input-mismatch');
    const complete = await completeOpenClawMessage(request, scope, matches[0]!);
    const inputId = consumedInputEvent([complete], turn, allowExecutionRunId, reselection);
    if (inputId !== anchor) throw new Error('dispatch-turn-input-mismatch');
    return inputId;
  }
  for await (const messages of openClawHistoryPages(request, scope, { first })) {
    const candidates = messages.filter((entry) => {
      if (entry.role !== 'user' || entry.__openclaw == null) return false;
      const meta = sessionObject(entry.__openclaw);
      return (
        meta.runId === turn.runId ||
        meta.idempotencyKey === `${turn.runId}:user` ||
        entry.idempotencyKey === `${turn.runId}:user`
      );
    });
    if (candidates.length) {
      const complete = await Promise.all(
        candidates.map((entry) => completeOpenClawMessage(request, scope, entry)),
      );
      return consumedInputEvent(complete, turn, allowExecutionRunId, reselection);
    }
  }
  return consumedInputEvent([], turn, allowExecutionRunId, reselection);
}

/** reconcile exact native custody without sending another input. */
export async function reconcileOpenClawTurn(input: {
  request: DispatchRequest;
  sessionKey: string;
  sessionId: string;
  turn: OpenClawTurn;
  allowExecutionRunId?: boolean;
  reselection?: FeedbackReselection;
  record?: Pick<OpenClawDispatchRecord, 'nativeInactive'>;
  save(): Promise<void>;
}) {
  const { request, turn, save } = input;
  if (turn.status !== 'completed') {
    const history = sessionObject(
      await request('chat.history', {
        sessionKey: input.sessionKey,
        inputRunIds: [turn.runId],
      }),
    );
    if (
      history.sessionId !== input.sessionId ||
      !Array.isArray(history.messages) ||
      !Array.isArray(history.inputReceipts)
    )
      throw new Error('dispatch-turn-history-unverified');
    const receipts = history.inputReceipts
      .map(sessionObject)
      .filter((entry) => entry.runId === turn.runId);
    if (receipts.length > 1) throw new Error('dispatch-turn-receipt-invalid');
    const receipt = receipts[0];
    const info = sessionObject(history.sessionInfo);
    const pending = sessionObject(history.pendingInputs ?? {}).total;
    if (input.record) {
      delete input.record.nativeInactive;
      if (
        info.hasActiveRun === true ||
        (typeof pending === 'number' && Number.isSafeInteger(pending) && pending > 0)
      )
        input.record.nativeInactive = false;
      else if (info.hasActiveRun === false && pending === 0) input.record.nativeInactive = true;
    }
    delete turn.inactive;
    if (receipt?.cancelled === true || turn.cancelled) {
      turn.cancelled = true;
      turn.inactive = info.hasActiveRun === false && receipt?.queued !== true;
      await save();
      throw new Error('dispatch-turn-cancelled');
    }
    const consumedByEventId =
      !receipt || (input.allowExecutionRunId && receipt.state === 'consumed')
        ? await openClawConsumedInput(
            request,
            input,
            turn,
            history,
            input.allowExecutionRunId,
            input.reselection,
          )
        : receipt.state === 'consumed' &&
            typeof receipt.consumedByEventId === 'string' &&
            receipt.consumedByEventId
          ? receipt.consumedByEventId
          : undefined;
    if (consumedByEventId) {
      if (turn.consumedByEventId && turn.consumedByEventId !== consumedByEventId)
        throw new Error('dispatch-turn-input-mismatch');
      turn.status = 'consumed';
      turn.consumedByEventId = consumedByEventId;
    } else if (receipt?.state === 'pending') {
      if (turn.consumedByEventId) throw new Error('dispatch-turn-receipt-regressed');
      turn.status = 'accepted';
    } else throw new Error('dispatch-turn-receipt-invalid');
    await save();
    const executionRunId = turn.executionRunId ?? turn.runId;
    const observed = sessionObject(
      await request('agent.wait', { runId: executionRunId, timeoutMs: 0 }),
    );
    if (observed.runId !== executionRunId) throw new Error('dispatch-turn-run-mismatch');
    if (observed.stopReason === 'aborted') {
      turn.cancelled = true;
      turn.inactive = info.hasActiveRun === false && receipt?.queued !== true;
      await save();
      throw new Error('dispatch-turn-cancelled');
    }
    if (observed.status === 'error') {
      if (info.hasActiveRun !== false || receipt?.queued === true || !turn.consumedByEventId)
        throw new Error('dispatch-turn-outcome-unverified');
      turn.status = 'completed';
      turn.failed = true;
      await save();
      return;
    }
    if (info.hasActiveRun === true || receipt?.queued === true) return;
    const reply =
      turn.status === 'consumed' && info.hasActiveRun === false
        ? await openClawTurnReply(request, input, executionRunId, { first: history })
        : undefined;
    if (reply && turn.status === 'consumed' && info.hasActiveRun === false) {
      let executionModel: string | undefined;
      if (observed.terminalReceipt) {
        const terminal = sessionObject(observed.terminalReceipt);
        if (terminal.runId !== executionRunId || terminal.sessionId !== input.sessionId)
          throw new Error('dispatch-turn-terminal-mismatch');
        const effective = sessionObject(terminal.effective);
        if (typeof effective.provider === 'string' && typeof effective.model === 'string')
          executionModel = `${effective.provider}/${effective.model}`;
      }
      turn.status = 'completed';
      turn.replyEventId = String(sessionObject(reply.__openclaw).id);
      if (executionModel) turn.executionModel = executionModel;
    } else if (info.hasActiveRun !== true && receipt?.queued !== true) {
      throw new Error('dispatch-turn-outcome-unverified');
    }
  }
}
