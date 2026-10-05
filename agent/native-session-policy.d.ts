// the public sdk exports these pure policy readers without declarations.
declare module 'openclaw/plugin-sdk/session-visibility' {
  import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
  export function createAgentToAgentPolicy(config: OpenClawConfig): {
    enabled: boolean;
    matchesAllow(agentId: string): boolean;
    isAllowed(requesterAgentId: string, targetAgentId: string): boolean;
  };
  export function resolveSessionToolsVisibility(
    config: OpenClawConfig,
  ): 'self' | 'tree' | 'agent' | 'all';
}
