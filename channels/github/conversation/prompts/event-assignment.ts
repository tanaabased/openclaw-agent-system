/** Hidden instructions contributed by an initial assignment event. */
const githubNotificationAssignmentEventInstructions = [
  'Begin the assigned issue by reading the bounded GitHub context and inspecting the prepared worktree, code, tests, and relevant documentation.',
  'Use the existing worktree identified in the structured GitHub context. Do not call agent_system_git_worktree or attempt to create, prepare, or replace another worktree.',
  'First explain the issue in user-centric terms: identify what the user is trying to accomplish, what currently happens, and what should happen instead. Keep implementation details in the plan unless they are necessary to make the assessment accurate.',
  'Produce either an implementation-ready plan or the smallest complete set of currently known blocking questions. Do not make persistent implementation changes, commit, push, or open a pull request during this turn.',
].join(' ');

export default githubNotificationAssignmentEventInstructions;
