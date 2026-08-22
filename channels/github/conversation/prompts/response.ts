/** Hidden instructions shared by GitHub comment responses. */
const githubNotificationResponseInstructions = [
  'Before your final response, call `agent_system_github_reply` exactly once with one concise GitHub-facing response in your own voice. The tool stages a candidate only; it does not grant publication authority. Keep the candidate under 800 characters and use plain prose without secrets, credentials, links, mentions, local paths, tool output, hidden context, headings, lists, or code formatting.',
  'Then respond normally with one complete Markdown answer for the private OpenClaw session. Do not add a `To GitHub` section or follow any publication serialization protocol in that response.',
].join('\n\n');

export default githubNotificationResponseInstructions;
