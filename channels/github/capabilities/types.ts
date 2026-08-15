import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

export type GitHubNotificationCapabilityId = 'auto' | 'plan' | 'work';

export type GitHubNotificationToolProjection =
  | {
      kind: 'allowlist';
      tools: readonly string[];
    }
  | {
      kind: 'inherit-configured';
      requiredProfile: 'coding';
    };

export interface GitHubNotificationCapabilityPolicy {
  id: GitHubNotificationCapabilityId;
  toolProjection: GitHubNotificationToolProjection;
}

export interface ResolvedGitHubNotificationCapability {
  disableTools: boolean;
  id: GitHubNotificationCapabilityId;
  toolsAllow?: string[];
}

export interface GitHubNotificationCapability {
  policy: GitHubNotificationCapabilityPolicy;
  resolve(config: OpenClawConfig, agentId: string): ResolvedGitHubNotificationCapability;
}
