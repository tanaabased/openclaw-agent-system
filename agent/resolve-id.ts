export interface AgentRuntimeContext {
  agentId?: string;
  sessionKey?: string;
}

/** Resolve only an agent id explicitly supplied by the host or encoded in an agent session key. */
export default function resolveAgentId(
  context: AgentRuntimeContext,
  parseSessionAgentId: (sessionKey: string) => string | undefined,
): string | undefined {
  const directAgentId = context.agentId?.trim();
  if (directAgentId) return directAgentId;

  const sessionKey = context.sessionKey?.trim();
  if (!sessionKey) return undefined;

  const sessionAgentId = parseSessionAgentId(sessionKey)?.trim();
  return sessionAgentId || undefined;
}
