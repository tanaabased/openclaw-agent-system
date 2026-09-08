/** Stable subset of host hook context consumed by Agent System. */
export interface AgentSystemHookContext {
  agentId?: string;
  channel?: string;
  channelContext?: {
    chat?: {
      id?: string;
    };
  };
  channelId?: string;
  chatId?: string;
  messageProvider?: string;
  sessionKey?: string;
  workspaceDir?: string;
}
