import createGitHubNotificationIssueWorkScenario from '../../scripts/github-notification-model-issue-work-scenario.ts';

export const githubNotificationPullRequestHandoffReplyCallId = 'call_agent_system_pr_handoff_reply';
export const githubNotificationPullRequestHandoffIssueCallId =
  'call_agent_system_github_pr_handoff_issue';
export const githubNotificationPullRequestHandoffPatchCallId =
  'call_apply_patch_pr_handoff_fixture';
export const githubNotificationPullRequestHandoffAddCallId = 'call_agent_system_git_pr_handoff_add';
export const githubNotificationPullRequestHandoffCommitCallId =
  'call_agent_system_git_pr_handoff_commit';

export const githubNotificationPullRequestCandidate =
  "This assignment asks for one exact pull request fixture. I'm going to verify the prepared worktree, create and commit only that file, and let the issue lifecycle deliver the managed branch as a normalized pull request.";

export const githubNotificationPullRequestAssignmentFinalResponse = [
  '## Assessment',
  '',
  'The requested pull request fixture is bounded and the prepared worktree is ready for implementation and managed delivery.',
  '',
  '## Plan',
  '',
  'Create the exact root fixture, validate and commit it once, then let the issue lifecycle reconcile the normalized pull request.',
].join('\n');

export const githubNotificationPullRequestFinalResponse = [
  '## Implementation',
  '',
  'Created the requested pull request fixture with the exact assigned contents.',
  '',
  '## Validation',
  '',
  'Confirmed the bounded file change before staging it.',
  '',
  '## Delivery',
  '',
  'Created one local commit in the prepared lifecycle worktree for managed pull request delivery.',
].join('\n');

export const pullRequestHandoffScenario = createGitHubNotificationIssueWorkScenario({
  assignmentFinalResponse: githubNotificationPullRequestAssignmentFinalResponse,
  callIds: {
    add: githubNotificationPullRequestHandoffAddCallId,
    commit: githubNotificationPullRequestHandoffCommitCallId,
    issue: githubNotificationPullRequestHandoffIssueCallId,
    patch: githubNotificationPullRequestHandoffPatchCallId,
    reply: githubNotificationPullRequestHandoffReplyCallId,
  },
  candidate: githubNotificationPullRequestCandidate,
  commitMessage: 'add pull request fixture',
  fileContents: 'pull request fixture ready.',
  filenamePattern: /\bpull-request-fixture-[0-9]+-[0-9]+\.txt\b/u,
  finalResponse: githubNotificationPullRequestFinalResponse,
  id: 'pr-handoff',
});
