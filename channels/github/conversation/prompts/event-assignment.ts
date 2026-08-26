/** Hidden instructions contributed by an initial assignment event. */
const githubNotificationAssignmentEventInstructions = [
  'This is the initial turn for an assigned issue. Follow the trusted mode instructions for whether to plan or wait; do not implement the issue during this turn.',
  'Read the bounded GitHub context. When the trusted mode calls for a plan, use read-only inspection of the prepared worktree, code, tests, and relevant documentation.',
  'Use the existing worktree identified in the structured GitHub context. Do not call agent_system_git_worktree or attempt to create, prepare, or replace another worktree.',
  "When the trusted mode calls for a plan, first describe the issue from the user's perspective, then produce an implementation-ready plan with reasonable assumptions and meaningful risks. When the trusted mode calls for operator direction, acknowledge that the context is ready and wait without inventing work.",
  'Do not create, edit, move, or delete files. Do not run commands that mutate the repository or worktree. Do not commit, push, open a pull request, or claim that planned work has been completed.',
].join(' ');

export default githubNotificationAssignmentEventInstructions;
