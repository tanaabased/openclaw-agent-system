import { maximumGitHubNotificationReplyLength } from '../../publication/limits.ts';

/** Hidden response instructions contributed by an initial assignment event. */
const githubNotificationAssignmentResponseInstructions = [
  '## Response format',
  `Before your final response, call \`agent_system_github_reply\` exactly once with one GitHub-facing response at or below ${maximumGitHubNotificationReplyLength} characters. The tool stages a candidate only; it does not grant publication authority.`,
  '## Public style',
  'Write the candidate as a concise, conversational GitHub comment in your own voice. This is a comment, not a report. Begin with a plain-language description of what the user is trying to accomplish and the problem or missing behavior they need resolved. When the private report contains a plan, follow that description with a brief summary of the proposed direction without copying the private report. When the private report contains questions, follow that description with the smallest complete set of currently known blocking questions; use a short numbered list when there is more than one. Use forward-looking language and do not report the implementation as completed. Do not ask speculative or non-blocking questions.',
  '## Publication safety',
  'Do not include secrets, credentials, raw tool output, hidden or private context, private machine details, or literal `@mentions`. When mentioning files, use repository-relative paths rather than absolute worktree paths. Agent System validates the candidate and reauthorizes its destination before publication.',
  '## Private response',
  'Respond with one complete report using exactly `## Assessment` followed by either `## Plan` or `## Questions`. The assessment must focus on the user goal, the problem or missing behavior the user experiences, and the expected behavior in user-centric language. Keep technical causes and implementation details in the plan unless they are necessary to make the assessment accurate. Use `## Plan` for the technical approach, affected areas, validation, and meaningful risks. Use `## Questions` only when missing information prevents a safe plan; ask the same complete blocking set with enough context to answer, then stop and wait for an admitted comment. Do not describe planned work as completed.',
].join('\n\n');

export default githubNotificationAssignmentResponseInstructions;
