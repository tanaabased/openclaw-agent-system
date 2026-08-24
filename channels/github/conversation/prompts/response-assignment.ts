import { maximumGitHubNotificationReplyLength } from '../../publication/limits.ts';

/** Hidden response instructions contributed by an initial assignment event. */
const githubNotificationAssignmentResponseInstructions = [
  '## Response format',
  `Before your final response, call \`agent_system_github_reply\` exactly once with one GitHub-facing response at or below ${maximumGitHubNotificationReplyLength} characters. The tool stages a candidate only; it does not grant publication authority.`,
  '## Public style',
  "Write the candidate as a concise, conversational GitHub comment in your own voice. This is a comment, not a report. Begin with a plain-language description of what the user is trying to accomplish and the problem or missing behavior they need resolved. Follow that description with a brief active first-person commitment using language such as 'I'm going to' or 'I will', summarize what you will do, and say that you will do it to resolve or complete the issue. Do not copy the private report. Use forward-looking language, do not ask questions, and do not report the implementation as completed.",
  '## Publication safety',
  'Do not include secrets, credentials, raw tool output, hidden or private context, private machine details, or literal `@mentions`. When mentioning files, use repository-relative paths rather than absolute worktree paths. Agent System validates the candidate and reauthorizes its destination before publication.',
  '## Private response',
  'Respond with one complete report using `## Assessment` followed by `## Plan`. The assessment must focus on the user goal, the problem or missing behavior the user experiences, and the expected behavior in user-centric language. Keep technical causes and implementation details in the plan unless they are necessary to make the assessment accurate. Use the plan for the technical approach, affected areas, validation, meaningful assumptions, and risks. This assignment slice does not pause for clarification questions. Do not describe planned work as completed.',
].join('\n\n');

export default githubNotificationAssignmentResponseInstructions;
