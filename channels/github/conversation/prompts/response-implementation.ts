/** Hidden response instructions contributed by a scheduled implementation event. */
const githubNotificationImplementationResponseInstructions = [
  '## Response format',
  'Do not call `agent_system_github_reply` or stage a GitHub-facing response during this turn.',
  '## Private response',
  'Respond with a concise report for the private OpenClaw session. Use `## Implementation` for the work completed and `## Validation` for the checks and results. If blocked, use `## Blocked` with the exact blocker and the smallest action needed to continue. Do not claim a commit, push, pull request, or GitHub publication occurred.',
].join('\n\n');

export default githubNotificationImplementationResponseInstructions;
