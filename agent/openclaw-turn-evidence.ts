import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import {
  completeOpenClawMessage,
  openClawHistoryPages,
  type HistoryScope,
} from './openclaw-history.ts';
import { sessionObject } from './openclaw-session-create.ts';
import issueTurnReply from './openclaw-session-reply.ts';

/** discover the terminal candidate, then obtain its complete native representation. */
export default async function openClawTurnReply(
  request: DispatchRequest,
  scope: HistoryScope,
  runId: string,
  options: { messageId?: string; first?: Record<string, unknown> } = {},
) {
  let incomplete: unknown;
  for await (const messages of openClawHistoryPages(request, scope, options)) {
    for (const message of messages.toReversed()) {
      if (message.role !== 'assistant' || message.__openclaw == null) continue;
      const meta = sessionObject(message.__openclaw);
      if (
        meta.runId !== runId ||
        meta.runTerminal === false ||
        (message.stopReason !== undefined &&
          !['stop', 'end_turn'].includes(String(message.stopReason)))
      )
        continue;
      let complete: Record<string, unknown>;
      try {
        complete = await completeOpenClawMessage(request, scope, message);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !['workflow-evidence-missing', 'workflow-evidence-truncated'].includes(error.message)
        )
          throw error;
        // Oversized display placeholders omit terminal flags, so this may be an intermediate row.
        incomplete ??= error;
        continue;
      }
      const reply = issueTurnReply([complete], runId);
      if (reply) return reply;
    }
  }
  if (incomplete) throw incomplete;
}
