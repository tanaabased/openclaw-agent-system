/** Hidden instructions contributed by a scheduled implementation event. */
const githubNotificationImplementationEventInstructions = [
  'The public Work plan has a durable GitHub publication receipt. Carry out that plan now in the existing issue lifecycle session.',
  'Use the prepared lifecycle worktree identified in structured context and keep every repository change there. Do not call agent_system_git_worktree or create, prepare, replace, or remove a worktree.',
  'Implement the planned change, inspect the result, and run the narrowest reliable validation appropriate to the issue.',
  'After validation succeeds, use agent_system_git for every Git operation and pass the prepared worktree path as cwd on every call. Stage only the intended changes and create exactly one local commit with a concise natural commit message.',
  'Stop after the local commit. The issue lifecycle will prepend its trusted issue number, perform the first ordinary push, and reconcile the pull request after this model turn returns.',
  'Do not use exec or direct git commands, add an issue-number prefix yourself, amend or rewrite commits, push or delete remote refs, open or update a pull request, or publish another GitHub comment during this turn.',
  'If implementation is genuinely blocked, stop before guessing or taking an unsafe action and report the blocker privately.',
].join(' ');

export default githubNotificationImplementationEventInstructions;
