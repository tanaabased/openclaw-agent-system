interface ModelToolResultMessage {
  role: string;
  tool_call_id?: string;
}

/** Match an authored call id or OpenClaw's normalized Responses item framing. */
export function matchesGitHubNotificationModelToolCallId(
  observedCallId: string,
  authoredCallId: string,
): boolean {
  if (observedCallId === authoredCallId) return true;
  if (!observedCallId.startsWith(authoredCallId)) return false;
  return /^_fc[-_][A-Za-z0-9_-]+$/u.test(observedCallId.slice(authoredCallId.length));
}

/** Match only the result for one scenario-owned model tool call. */
export default function hasGitHubNotificationModelToolResult(
  messages: readonly ModelToolResultMessage[],
  callId: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string' &&
      matchesGitHubNotificationModelToolCallId(message.tool_call_id, callId),
  );
}
