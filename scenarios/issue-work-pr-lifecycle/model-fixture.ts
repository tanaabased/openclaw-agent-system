import createGitHubNotificationIssueWorkScenario from '../../scripts/github-notification-model-issue-work-scenario.ts';

export const githubNotificationPullRequestLifecycleReplyCallId =
  'call_agent_system_pr_lifecycle_reply';
export const githubNotificationPullRequestLifecycleIssueCallId =
  'call_agent_system_github_pr_lifecycle_issue';
export const githubNotificationPullRequestLifecyclePatchCallId =
  'call_apply_patch_pr_lifecycle_fixture';
export const githubNotificationPullRequestLifecycleAddCallId =
  'call_agent_system_git_pr_lifecycle_add';
export const githubNotificationPullRequestLifecycleCommitCallId =
  'call_agent_system_git_pr_lifecycle_commit';

export const githubNotificationPullRequestLifecycleCandidate =
  "This assignment asks for one exact pull request lifecycle fixture. I'm going to verify the prepared worktree, create and commit only that file, and let the issue lifecycle deliver the managed branch as a normalized pull request.";

export const githubNotificationPullRequestLifecycleAssignmentFinalResponse = [
  '## Assessment',
  '',
  'The requested pull request lifecycle fixture is bounded and the prepared worktree is ready for implementation and managed delivery.',
  '',
  '## Plan',
  '',
  'Create the exact root fixture, validate and commit it once, then let the issue lifecycle reconcile the normalized pull request.',
].join('\n');

export const githubNotificationPullRequestLifecycleFinalResponse = [
  '## Implementation',
  '',
  'Created the requested pull request lifecycle fixture with the exact assigned contents.',
  '',
  '## Validation',
  '',
  'Confirmed the bounded file change before staging it.',
  '',
  '## Delivery',
  '',
  'Created one local commit in the prepared lifecycle worktree for managed pull request delivery.',
].join('\n');

export const githubNotificationPullRequestLifecycleCommentFinalResponse =
  '{{commenter}}, the approved pull request comment received a direct response.';

export const pullRequestLifecycleScenario = createGitHubNotificationIssueWorkScenario({
  assignmentFinalResponse: githubNotificationPullRequestLifecycleAssignmentFinalResponse,
  callIds: {
    add: githubNotificationPullRequestLifecycleAddCallId,
    commit: githubNotificationPullRequestLifecycleCommitCallId,
    issue: githubNotificationPullRequestLifecycleIssueCallId,
    patch: githubNotificationPullRequestLifecyclePatchCallId,
    reply: githubNotificationPullRequestLifecycleReplyCallId,
  },
  candidate: githubNotificationPullRequestLifecycleCandidate,
  comment: {
    finalResponse: githubNotificationPullRequestLifecycleCommentFinalResponse,
    replyTokenPattern: /\bpr-ready-[0-9]+-[0-9]+\b/u,
  },
  commitMessage: 'add pull request lifecycle fixture',
  fileContents: 'pull request lifecycle fixture ready.',
  filenamePattern: /\bpull-request-lifecycle-fixture-[0-9]+-[0-9]+\.txt\b/u,
  finalResponse: githubNotificationPullRequestLifecycleFinalResponse,
  id: 'pr-lifecycle',
});
