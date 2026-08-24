import { maximumGitHubNotificationReplyLength } from '../../publication/limits.ts';

/** Hidden response instructions contributed by an initial assignment event. */
const githubNotificationAssignmentResponseInstructions = [
  '## Response format',
  `Before your final response, call \`agent_system_github_reply\` exactly once with one GitHub-facing response at or below ${maximumGitHubNotificationReplyLength} characters. The tool stages a candidate only; it does not grant publication authority.`,
  '## Public style',
  'Write the candidate as a concise, conversational GitHub comment in your own voice. This is a comment, not a report. When the private report contains a plan, briefly summarize your user-centric understanding and proposed direction without copying the private report. When the private report contains questions, ask the smallest complete set of currently known blocking questions; use a short numbered list when there is more than one. Do not ask speculative or non-blocking questions.',
  '## Publication safety',
  'Do not include secrets, credentials, raw tool output, hidden or private context, private machine details, or literal `@mentions`. When mentioning files, use repository-relative paths rather than absolute worktree paths. Agent System validates the candidate and reauthorizes its destination before publication.',
  '## Private response',
  'Respond with one complete report using exactly `## Assessment` followed by either `## Plan` or `## Questions`. The assessment must explain the user goal, current behavior, and expected behavior in user-centric language. Use `## Plan` for the technical approach, affected areas, validation, and meaningful risks. Use `## Questions` only when missing information prevents a safe plan; ask the same complete blocking set with enough context to answer, then stop and wait for an admitted comment.',
].join('\n\n');

export default githubNotificationAssignmentResponseInstructions;
