import createGitHubNotificationIssueWorkScenario from '../../scripts/github-notification-model-issue-work-scenario.ts';

export const githubNotificationImplementationReplyCallId = 'call_agent_system_implementation_reply';
export const githubNotificationImplementationPatchCallId =
  'call_apply_patch_implementation_fixture';
export const githubNotificationImplementationIssueCallId =
  'call_agent_system_github_implementation_issue';
export const githubNotificationImplementationAddCallId = 'call_agent_system_git_implementation_add';
export const githubNotificationImplementationCommitCallId =
  'call_agent_system_git_implementation_commit';

export const githubNotificationImplementationCandidate =
  "This assignment asks for one exact repository fixture. I'm going to confirm the prepared worktree, create only that file, validate its contents, and commit the bounded change for lifecycle delivery.";

export const githubNotificationImplementationAssignmentFinalResponse = [
  '## Assessment',
  '',
  'The requested implementation fixture is bounded and the prepared worktree is ready for the scheduled implementation turn.',
  '',
  '## Plan',
  '',
  'Create the exact root fixture, validate its contents and worktree state, then commit it once for managed lifecycle delivery.',
].join('\n');

export const githubNotificationImplementationFinalResponse = [
  '## Implementation',
  '',
  'Created the requested root fixture with the exact assigned contents.',
  '',
  '## Validation',
  '',
  'Confirmed the bounded file change before staging it.',
  '',
  '## Delivery',
  '',
  'Created one local commit in the prepared lifecycle worktree for managed delivery.',
].join('\n');

export const implementationScenario = createGitHubNotificationIssueWorkScenario({
  assignmentFinalResponse: githubNotificationImplementationAssignmentFinalResponse,
  callIds: {
    add: githubNotificationImplementationAddCallId,
    commit: githubNotificationImplementationCommitCallId,
    issue: githubNotificationImplementationIssueCallId,
    patch: githubNotificationImplementationPatchCallId,
    reply: githubNotificationImplementationReplyCallId,
  },
  candidate: githubNotificationImplementationCandidate,
  commitMessage: 'add implementation fixture',
  fileContents: 'implementation fixture ready.',
  filenamePattern: /\bimplementation-fixture-[0-9]+-[0-9]+\.txt\b/u,
  finalResponse: githubNotificationImplementationFinalResponse,
  id: 'implementation',
});
