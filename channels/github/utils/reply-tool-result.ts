export const githubNotificationReplyToolName = 'agent_system_github_reply';

export interface GitHubNotificationReplyToolOutput {
  body: string;
  kind: 'github-reply-candidate';
  version: 1;
}

/** Build the typed, non-authoritative candidate returned by the reply tool. */
export function githubNotificationReplyToolOutput(body: string): GitHubNotificationReplyToolOutput {
  return { body: body.trim(), kind: 'github-reply-candidate', version: 1 };
}
