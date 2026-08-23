export interface GitHubNotificationPromptComposition {
  eventInstructions: string;
  lifecycleInstructions: string;
  modeInstructions: string;
  modeLifecycleInstructions?: string;
  responseInstructions: string;
}

function section(heading: string, instructions?: string): string | undefined {
  const normalized = instructions?.trim();
  return normalized ? `## ${heading}\n\n${normalized}` : undefined;
}

/** Compose trusted instruction layers without provider-controlled values. */
export default function composeGitHubNotificationPrompt(
  input: GitHubNotificationPromptComposition,
): string {
  return [
    section('Lifecycle', input.lifecycleInstructions),
    section('Lifecycle mode', input.modeLifecycleInstructions),
    section('Mode', input.modeInstructions),
    section('Event', input.eventInstructions),
    input.responseInstructions,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n\n');
}
