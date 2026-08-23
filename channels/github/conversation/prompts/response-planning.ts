import { maximumGitHubNotificationReplyLength } from '../../publication/limits.ts';

/** Hidden response instructions shared by assignment planning turns. */
const githubNotificationPlanningResponseInstructions = [
  '## Response format',
  `Before your final response, call \`agent_system_github_reply\` exactly once with a \`body\` at or below ${maximumGitHubNotificationReplyLength} characters and an \`outcome\` of either \`plan\` or \`questions\`. The tool stages a typed candidate only; it does not grant publication authority.`,
  '## Public style',
  'Write the candidate as a concise, conversational GitHub comment in your own voice. This is a comment, not a report. For a plan outcome, briefly summarize your understanding and proposed direction without copying the private report. For a questions outcome, ask the smallest complete set of currently known blocking questions; use a short numbered list when there is more than one. Do not ask speculative or non-blocking questions.',
  '## Publication safety',
  'Do not include secrets, credentials, local paths, raw tool output, hidden or private context, or literal `@mentions`. Agent System validates the candidate and reauthorizes its destination before publication.',
  '## Private plan outcome',
  'When the outcome is `plan`, respond with one complete report using exactly `## Assessment` followed by `## Plan`. The assessment must explain the user goal, current behavior, and expected behavior in user-centric language. Put the technical approach, affected areas, validation, and meaningful risks in the plan.',
  '## Private questions outcome',
  'When the outcome is `questions`, respond with one complete report using exactly `## Assessment` followed by `## Questions`. Include what is already understood in the assessment, then ask the same complete set of blocking questions with enough context to answer them. Stop after the questions and wait for another admitted comment.',
].join('\n\n');

export default githubNotificationPlanningResponseInstructions;
