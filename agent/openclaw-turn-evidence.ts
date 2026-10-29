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
  for await (const messages of openClawHistoryPages(request, scope, options)) {
    for (const message of messages.toReversed()) {
      const meta = sessionObject(message.__openclaw);
      if (
        message.role !== 'assistant' ||
        meta.runId !== runId ||
        meta.runTerminal === false ||
        (message.stopReason !== undefined &&
          !['stop', 'end_turn'].includes(String(message.stopReason)))
      )
        continue;
      const complete = await completeOpenClawMessage(request, scope, message);
      const reply = issueTurnReply([complete], runId);
      if (reply) return reply;
    }
  }
}
