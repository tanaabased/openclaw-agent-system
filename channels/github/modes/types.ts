import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

export type GitHubNotificationModeId = 'auto' | 'plan' | 'work';

export type GitHubNotificationToolProjection =
  | {
      kind: 'allowlist';
      tools: readonly string[];
    }
  | {
      kind: 'inherit-configured';
      requiredProfile: 'coding';
    };

export interface GitHubNotificationModePolicy {
  id: GitHubNotificationModeId;
  toolProjection: GitHubNotificationToolProjection;
}

export interface ResolvedGitHubNotificationMode {
  disableTools: boolean;
  id: GitHubNotificationModeId;
  toolsAllow?: string[];
}

export interface GitHubNotificationMode {
  policy: GitHubNotificationModePolicy;
  resolve(config: OpenClawConfig, agentId: string): ResolvedGitHubNotificationMode;
}
