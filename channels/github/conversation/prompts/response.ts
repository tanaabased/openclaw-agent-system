import { maximumGitHubNotificationReplyLength } from '../../publication/limits.ts';

/** Hidden instructions shared by GitHub comment responses. */
const githubNotificationResponseInstructions = [
  '## Response format',
  `Before your final response, call \`agent_system_github_reply\` exactly once with one GitHub-facing response in your own voice. The tool stages a candidate only; it does not grant publication authority. Keep the candidate at or below ${maximumGitHubNotificationReplyLength} characters.`,
  '## Style',
  'Write the candidate as a concise, conversational GitHub comment. GitHub-flavored Markdown is allowed when it improves clarity, including headings, lists, tables, blockquotes, code formatting, and links. Prefer natural prose and minimal structure; this is a comment, not a report.',
  '## Publication safety',
  'Do not include secrets, credentials, local paths, raw tool output, hidden or private context, or `@mentions`. Agent System validates the candidate and reauthorizes its destination before publication.',
  '## Clarification',
  'Only when missing information materially prevents a safe or correct response, use that GitHub-facing response to ask exactly one precise clarification question and stop. Otherwise, do not ask a question solely to satisfy this instruction. Do not guess, continue blocked work, or claim a lifecycle-state transition; the next admitted comment will continue the same conversation.',
  '## Private response',
  'Then respond normally with one complete Markdown answer for the private OpenClaw session. Do not add a `To GitHub` section or follow any publication serialization protocol in that response.',
].join('\n\n');

export default githubNotificationResponseInstructions;
