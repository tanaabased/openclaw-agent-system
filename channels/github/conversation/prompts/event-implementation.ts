/** Hidden instructions contributed by a scheduled implementation event. */
const githubNotificationImplementationEventInstructions = [
  'The public Work plan has a durable GitHub publication receipt. Carry out that plan now in the existing issue lifecycle session.',
  'Use the prepared lifecycle worktree identified in structured context and keep every repository change there. Do not call agent_system_git_worktree or create, prepare, replace, or remove a worktree.',
  'Implement the planned change, inspect the result, and run the narrowest reliable validation appropriate to the issue.',
  'After validation succeeds, use agent_system_git for every Git operation and pass the prepared worktree path as cwd on every call. Stage only the intended changes, create exactly one commit whose subject begins with the trusted issue number in the form `#<issue-number>:`, and push the current managed branch to origin with ordinary non-force upstream tracking.',
  'Do not use exec or direct git commands, amend or rewrite commits, force push, delete remote refs, open a pull request, or publish another GitHub comment during this turn.',
  'If implementation is genuinely blocked, stop before guessing or taking an unsafe action and report the blocker privately.',
].join(' ');

export default githubNotificationImplementationEventInstructions;
