import issueInputEvent, { issueInputEventId } from './openclaw-session-input.ts';
import issueTurnReply from './openclaw-session-reply.ts';
import { sessionObject } from './openclaw-session-create.ts';
import type { OpenClawTurn } from './openclaw-turn-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
/** ordinary consumed inputs leave the pending table; verify their exact transcript identity. */
export function consumedInputEvent(messages: unknown[], turn: OpenClawTurn) {
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
  const eventId =
    turn.origin === 'assessment'
      ? issueInputEventId(entry, turn.runId)
      : issueInputEvent(entry, turn);
  if (!eventId) throw new Error('dispatch-turn-input-mismatch');
  return eventId;
}

/** reconcile exact native custody without sending another input. */
export async function reconcileOpenClawTurn(input: {
  request: DispatchRequest;
  sessionKey: string;
  sessionId: string;
  model: string;
  turn: OpenClawTurn;
  save(): Promise<void>;
}) {
  const { request, turn, save } = input;
  if (turn.status !== 'completed') {
    const history = sessionObject(
      await request('chat.history', {
        sessionKey: input.sessionKey,
        inputRunIds: [turn.runId],
        limit: 200,
        maxChars: 100000,
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
    delete turn.inactive;
    if (receipt?.cancelled === true || turn.cancelled) {
      turn.cancelled = true;
      turn.inactive = info.hasActiveRun === false && receipt?.queued !== true;
      await save();
      throw new Error('dispatch-turn-cancelled');
    }
    const consumedByEventId = !receipt
      ? consumedInputEvent(history.messages, turn)
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
    const observed = sessionObject(
      await request('agent.wait', { runId: turn.runId, timeoutMs: 0 }),
    );
    if (observed.runId !== turn.runId) throw new Error('dispatch-turn-run-mismatch');
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
    const reply = issueTurnReply(history.messages, turn.runId);
    if (reply && turn.status === 'consumed' && info.hasActiveRun === false) {
      let executionModel: string | undefined;
      if (observed.terminalReceipt) {
        const terminal = sessionObject(observed.terminalReceipt);
        if (terminal.runId !== turn.runId || terminal.sessionId !== input.sessionId)
          throw new Error('dispatch-turn-terminal-mismatch');
        const effective = sessionObject(terminal.effective);
        if (typeof effective.provider === 'string' && typeof effective.model === 'string')
          executionModel = `${effective.provider}/${effective.model}`;
      }
      if (executionModel && executionModel !== input.model)
        throw new Error('dispatch-turn-model-mismatch');
      turn.status = 'completed';
      turn.replyEventId = String(sessionObject(reply.__openclaw).id);
      if (executionModel) turn.executionModel = executionModel;
    } else if (info.hasActiveRun !== true && receipt?.queued !== true) {
      throw new Error('dispatch-turn-outcome-unverified');
    }
  }
}
