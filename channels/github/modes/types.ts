export const githubNotificationModeIds = ['auto', 'plan', 'work'] as const;

export type GitHubNotificationModeId = (typeof githubNotificationModeIds)[number];

export function isGitHubNotificationModeId(value: unknown): value is GitHubNotificationModeId {
  return githubNotificationModeIds.includes(value as GitHubNotificationModeId);
}

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
  label: string;
  toolProjection: GitHubNotificationToolProjection;
}

export interface ResolvedGitHubNotificationMode {
  disableTools: boolean;
  id: GitHubNotificationModeId;
  toolsAllow?: string[];
}

export interface GitHubNotificationMode {
  instructions: string;
  policy: GitHubNotificationModePolicy;
}
