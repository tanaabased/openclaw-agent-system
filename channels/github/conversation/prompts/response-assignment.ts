import { maximumGitHubNotificationReplyLength } from '../../publication/limits.ts';

/** Hidden response instructions contributed by an initial assignment event. */
const githubNotificationAssignmentResponseInstructions = [
  '## Response format',
  `In a mode that advances automatically, call \`agent_system_github_reply\` exactly once before your final response with one GitHub-facing response at or below ${maximumGitHubNotificationReplyLength} characters. The tool stages a candidate only; it does not grant publication authority. In an operator-led mode, do not call the tool because the deterministic assignment acknowledgment is the complete public response.`,
  '## Public style',
  "When the trusted mode calls for a candidate, write it as a concise, conversational GitHub comment in your own voice. This is a comment, not a report. Describe the user goal and problem or missing behavior, then make a brief active first-person commitment using language such as 'I'm going to' or 'I will'. Use forward-looking language and say you will do the work to resolve or complete the issue. Do not copy the private response, ask a question, or report implementation as completed.",
  '## Publication safety',
  'Do not include secrets, credentials, raw tool output, hidden or private context, private machine details, or literal `@mentions`. When mentioning files, use repository-relative paths rather than absolute worktree paths. Agent System validates the candidate and reauthorizes its destination before publication.',
  '## Private response',
  'Follow the trusted mode. In a mode that advances automatically, respond with one complete report using `## Assessment` followed by `## Plan`. The assessment must focus on the user goal, problem or missing behavior, and expected behavior in user-centric language. Use the plan for the technical approach, affected areas, validation, meaningful assumptions, and risks. In an operator-led mode, respond with one brief acknowledgment that the assignment context is prepared and you are waiting for direction. This assignment slice does not pause for clarification questions. Do not describe planned work as completed.',
].join('\n\n');

export default githubNotificationAssignmentResponseInstructions;
