interface AIMockToolResultMessage {
  content?: unknown;
  role: string;
  tool_call_id?: string;
}

/** Match an authored call id or OpenClaw's normalized Responses item framing. */
export function matchesOpenClawAIMockToolCallId(
  observedCallId: string,
  authoredCallId: string,
): boolean {
  if (observedCallId === authoredCallId) return true;
  if (!observedCallId.startsWith(authoredCallId)) return false;
  return /^_fc[-_][A-Za-z0-9_-]+$/u.test(observedCallId.slice(authoredCallId.length));
}

/** Match only the result for one scenario-owned model tool call. */
export function hasOpenClawAIMockToolResult(
  messages: readonly AIMockToolResultMessage[],
  callId: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string' &&
      matchesOpenClawAIMockToolCallId(message.tool_call_id, callId),
  );
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'object' && part !== null && 'text' in part
        ? (part as { text?: unknown }).text
        : undefined,
    )
    .filter((part): part is string => typeof part === 'string')
    .join('');
}

/** Read one scenario-owned tool result without accepting another call's output. */
export function openClawAIMockToolResultText(
  messages: readonly AIMockToolResultMessage[],
  callId: string,
): string | undefined {
  const message = messages.find(
    (candidate) =>
      candidate.role === 'tool' &&
      typeof candidate.tool_call_id === 'string' &&
      matchesOpenClawAIMockToolCallId(candidate.tool_call_id, callId),
  );
  return message === undefined ? undefined : contentText(message.content);
}

export default hasOpenClawAIMockToolResult;
