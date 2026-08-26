import createGitHubNotificationIssueWorkScenario from '../../scripts/github-notification-model-issue-work-scenario.ts';

export const githubNotificationPullRequestContinuationReplyCallId =
  'call_agent_system_pr_continuation_reply';
export const githubNotificationPullRequestContinuationIssueCallId =
  'call_agent_system_github_pr_continuation_issue';
export const githubNotificationPullRequestContinuationPatchCallId =
  'call_apply_patch_pr_continuation_fixture';
export const githubNotificationPullRequestContinuationAddCallId =
  'call_agent_system_git_pr_continuation_add';
export const githubNotificationPullRequestContinuationCommitCallId =
  'call_agent_system_git_pr_continuation_commit';
export const githubNotificationPullRequestContinuationCommentReplyCallId =
  'call_agent_system_pr_continuation_comment_reply';

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

export const githubNotificationPullRequestCommentFinalResponse =
  'Staged one concise response for the approved pull request comment.';

export const pullRequestContinuationScenario = createGitHubNotificationIssueWorkScenario({
  assignmentFinalResponse: githubNotificationPullRequestAssignmentFinalResponse,
  callIds: {
    add: githubNotificationPullRequestContinuationAddCallId,
    commit: githubNotificationPullRequestContinuationCommitCallId,
    issue: githubNotificationPullRequestContinuationIssueCallId,
    patch: githubNotificationPullRequestContinuationPatchCallId,
    reply: githubNotificationPullRequestContinuationReplyCallId,
  },
  candidate: githubNotificationPullRequestCandidate,
  comment: {
    finalResponse: githubNotificationPullRequestCommentFinalResponse,
    replyCallId: githubNotificationPullRequestContinuationCommentReplyCallId,
    replyTokenPattern: /\bpr-ready-[0-9]+-[0-9]+\b/u,
  },
  commitMessage: 'add pull request fixture',
  fileContents: 'pull request fixture ready.',
  filenamePattern: /\bpull-request-fixture-[0-9]+-[0-9]+\.txt\b/u,
  finalResponse: githubNotificationPullRequestFinalResponse,
  id: 'pr-continuation',
});
