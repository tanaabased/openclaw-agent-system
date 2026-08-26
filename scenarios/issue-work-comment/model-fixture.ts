import createGitHubNotificationIssueWorkScenario from '../../scripts/github-notification-model-issue-work-scenario.ts';

export const githubNotificationCommentAssignmentReplyCallId =
  'call_agent_system_comment_assignment_reply';
export const githubNotificationCommentIssueCallId = 'call_agent_system_github_comment_issue';
export const githubNotificationCommentPatchCallId = 'call_apply_patch_comment_fixture';
export const githubNotificationCommentAddCallId = 'call_agent_system_git_comment_add';
export const githubNotificationCommentCommitCallId = 'call_agent_system_git_comment_commit';

export const githubNotificationCommentCandidate =
  "This assignment asks for one exact comment fixture. I'm going to verify the prepared worktree, create and commit only that file, and let the issue lifecycle deliver the managed branch before responding to the follow-up comment.";

export const githubNotificationCommentAssignmentFinalResponse = [
  '## Assessment',
  '',
  'The requested comment fixture is bounded and the prepared worktree is ready for implementation and managed delivery.',
  '',
  '## Plan',
  '',
  'Create the exact root fixture, validate and commit it once, then answer the approved follow-up comment directly.',
].join('\n');

export const githubNotificationCommentImplementationFinalResponse = [
  '## Implementation',
  '',
  'Created the requested comment fixture with the exact assigned contents.',
  '',
  '## Validation',
  '',
  'Confirmed the bounded file change before staging it.',
  '',
  '## Delivery',
  '',
  'Created one local commit in the prepared lifecycle worktree for managed delivery.',
].join('\n');

export const githubNotificationCommentFinalResponse =
  '{{commenter}}, the approved GitHub comment received a direct response.';

export const commentScenario = createGitHubNotificationIssueWorkScenario({
  assignmentFinalResponse: githubNotificationCommentAssignmentFinalResponse,
  callIds: {
    add: githubNotificationCommentAddCallId,
    commit: githubNotificationCommentCommitCallId,
    issue: githubNotificationCommentIssueCallId,
    patch: githubNotificationCommentPatchCallId,
    reply: githubNotificationCommentAssignmentReplyCallId,
  },
  candidate: githubNotificationCommentCandidate,
  comment: {
    finalResponse: githubNotificationCommentFinalResponse,
    replyTokenPattern: /\bready-[0-9]+-[0-9]+\b/u,
  },
  commitMessage: 'add comment fixture',
  fileContents: 'comment fixture ready.',
  filenamePattern: /\bcomment-fixture-[0-9]+-[0-9]+\.txt\b/u,
  finalResponse: githubNotificationCommentImplementationFinalResponse,
  id: 'comment',
});
