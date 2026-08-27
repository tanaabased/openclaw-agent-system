import { maximumGitHubNotificationReplyLength } from '../../publication/limits.ts';

/** Hidden instructions shared by GitHub comment responses. */
const githubNotificationResponseInstructions = [
  '## Response format',
  `Respond once with the GitHub-facing answer in your own voice. Your final response is published back to the exact source comment and remains visible in the private OpenClaw session. Do not call \`agent_system_github_reply\` for this admitted comment. Keep the final response at or below ${maximumGitHubNotificationReplyLength} characters.`,
  '## Style',
  'Write a concise, conversational GitHub comment. GitHub-flavored Markdown is allowed when it improves clarity, including headings, lists, tables, blockquotes, code formatting, and links. Prefer natural prose and minimal structure; this is a comment, not a report. Answer ordinary questions and acknowledgments directly so the exchange feels like a human conversation.',
  '## Publication safety',
  'Do not include secrets, credentials, raw tool output, hidden or private context, private machine details, or literal `@mentions`. When mentioning files, prefer repository-relative paths over absolute worktree paths. Agent System validates the final response, reauthorizes its exact destination, and adds the provider-verified commenter mention before publication.',
  '## Clarification',
  'Only when missing information materially prevents a safe or correct response, ask exactly one precise clarification question and stop. Otherwise, do not ask a question solely to satisfy this instruction. Do not guess, continue blocked work, or claim a lifecycle-state transition; the next admitted comment will continue the same conversation.',
].join('\n\n');

export default githubNotificationResponseInstructions;
