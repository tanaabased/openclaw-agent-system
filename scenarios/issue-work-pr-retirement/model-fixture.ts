import createGitHubNotificationIssueWorkScenario from '../../scripts/github-notification-model-issue-work-scenario.ts';

export const githubNotificationPullRequestRetirementReplyCallId =
  'call_agent_system_pr_retirement_reply';
export const githubNotificationPullRequestRetirementIssueCallId =
  'call_agent_system_github_pr_retirement_issue';
export const githubNotificationPullRequestRetirementPatchCallId =
  'call_apply_patch_pr_retirement_fixture';
export const githubNotificationPullRequestRetirementAddCallId =
  'call_agent_system_git_pr_retirement_add';
export const githubNotificationPullRequestRetirementCommitCallId =
  'call_agent_system_git_pr_retirement_commit';

export const githubNotificationPullRequestRetirementCandidate =
  "This assignment asks for one exact pull request retirement fixture. I'm going to verify the prepared worktree, create and commit only that file, and let the issue lifecycle deliver the managed branch as a normalized pull request.";

export const githubNotificationPullRequestRetirementAssignmentFinalResponse = [
  '## Assessment',
  '',
  'The requested pull request retirement fixture is bounded and the prepared worktree is ready for implementation and managed delivery.',
  '',
  '## Plan',
  '',
  'Create the exact root fixture, validate and commit it once, then let the issue lifecycle reconcile the normalized pull request.',
].join('\n');

export const githubNotificationPullRequestRetirementFinalResponse = [
  '## Implementation',
  '',
  'Created the requested pull request retirement fixture with the exact assigned contents.',
  '',
  '## Validation',
  '',
  'Confirmed the bounded file change before staging it.',
  '',
  '## Delivery',
  '',
  'Created one local commit in the prepared lifecycle worktree for managed pull request delivery.',
].join('\n');

export const pullRequestRetirementScenario = createGitHubNotificationIssueWorkScenario({
  assignmentFinalResponse: githubNotificationPullRequestRetirementAssignmentFinalResponse,
  callIds: {
    add: githubNotificationPullRequestRetirementAddCallId,
    commit: githubNotificationPullRequestRetirementCommitCallId,
    issue: githubNotificationPullRequestRetirementIssueCallId,
    patch: githubNotificationPullRequestRetirementPatchCallId,
    reply: githubNotificationPullRequestRetirementReplyCallId,
  },
  candidate: githubNotificationPullRequestRetirementCandidate,
  commitMessage: 'add pull request retirement fixture',
  fileContents: 'pull request retirement fixture ready.',
  filenamePattern: /\bpull-request-retirement-fixture-[0-9]+-[0-9]+\.txt\b/u,
  finalResponse: githubNotificationPullRequestRetirementFinalResponse,
  id: 'pr-retirement',
});
