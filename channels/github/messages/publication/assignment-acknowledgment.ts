import type { GitHubNotificationExecutionMode } from '../types.ts';

/** Render the deterministic public receipt sent as soon as OpenClaw adopts an assignment turn. */
export default function githubNotificationAssignmentAcknowledgment(
  mode: GitHubNotificationExecutionMode,
): string {
  if (mode !== 'plan') {
    throw new Error(`GitHub notification ${mode} acknowledgments are not implemented.`);
  }
  return 'I received this assignment and started planning it.';
}
