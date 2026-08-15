export type GitHubNotificationAssignmentKind = 'issue' | 'pull-request';

export type GitHubNotificationExecutionMode = 'auto' | 'plan' | 'work';

export type GitHubNotificationMessageEvent =
  'assignment-received' | 'comment-received' | 'planning-request';

export type GitHubNotificationMessageOutcome =
  'clarification-needed' | 'comment-answered' | 'plan-ready';

export interface GitHubNotificationMessageRequest {
  assignmentKind: GitHubNotificationAssignmentKind;
  event: GitHubNotificationMessageEvent;
  mode: GitHubNotificationExecutionMode;
}

declare module 'openclaw/plugin-sdk/channel-inbound' {
  interface PluginHookChannelChatContext {
    agentSystemGitHubNotification?: GitHubNotificationMessageRequest;
  }
}
