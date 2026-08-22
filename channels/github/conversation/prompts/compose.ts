export interface GitHubNotificationPromptComposition {
  eventInstructions: string;
  lifecycleInstructions: string;
  modeInstructions: string;
  modeLifecycleInstructions?: string;
  responseInstructions: string;
}

/** Compose trusted instruction layers without provider-controlled values. */
export default function composeGitHubNotificationPrompt(
  input: GitHubNotificationPromptComposition,
): string {
  return [
    input.lifecycleInstructions,
    input.modeLifecycleInstructions,
    input.modeInstructions,
    input.eventInstructions,
    input.responseInstructions,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n\n');
}
