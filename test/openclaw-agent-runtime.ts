import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import configuredAgentEntries from '../core/configured-agents.ts';
import {
  resolveNotificationRoute,
  type NotificationRouteResolver,
} from '../channels/github/routing/routing.ts';

export function resolveTestAgentWorkspaceDir(config: OpenClawConfig, agentId: string): string {
  const normalizedAgentId = agentId.trim().toLowerCase();
  const entry = configuredAgentEntries(config).find(
    (candidate) => candidate.id.trim().toLowerCase() === normalizedAgentId,
  );
  const workspace = entry?.workspace ?? config.agents?.defaults?.workspace;
  if (!workspace) throw new Error(`No test workspace is configured for ${normalizedAgentId}.`);
  return workspace;
}

export const resolveTestNotificationRoute: NotificationRouteResolver = (
  config,
  desired,
  conversationId,
) => resolveNotificationRoute(config, desired, conversationId, resolveTestAgentWorkspaceDir);
