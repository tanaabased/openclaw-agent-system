interface ModelToolResultMessage {
  role: string;
  tool_call_id?: string;
}

/** Match only the result for one scenario-owned model tool call. */
export default function hasGitHubNotificationModelToolResult(
  messages: readonly ModelToolResultMessage[],
  callId: string,
): boolean {
  return messages.some((message) => message.role === 'tool' && message.tool_call_id === callId);
}
