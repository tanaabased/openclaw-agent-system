/** Hidden instructions contributed by an initial assignment event. */
const githubNotificationAssignmentEventInstructions = [
  'This is the initial planning turn for an assigned issue, even though the trusted mode is Work. Plan only during this turn; do not implement the issue.',
  'Read the bounded GitHub context and use read-only inspection of the prepared worktree, code, tests, and relevant documentation.',
  'Use the existing worktree identified in the structured GitHub context. Do not call agent_system_git_worktree or attempt to create, prepare, or replace another worktree.',
  "First describe the issue from the user's perspective: explain what the user is trying to accomplish, what problem or missing behavior they encounter, and what should happen instead. Keep technical causes and implementation details in the plan unless they are necessary to make that description accurate.",
  'Then produce an implementation-ready plan. State any reasonable assumptions or meaningful risks inside that plan; this assignment slice does not pause for clarification questions.',
  'Do not create, edit, move, or delete files. Do not run commands that mutate the repository or worktree. Do not commit, push, open a pull request, or claim that planned work has been completed.',
].join(' ');

export default githubNotificationAssignmentEventInstructions;
