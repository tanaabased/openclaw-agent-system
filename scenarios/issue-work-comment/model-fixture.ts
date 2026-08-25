import type { ChatCompletionRequest, Fixture, ToolCallResponse } from '@copilotkit/aimock';

import createGitHubNotificationIssueWorkScenario from '../../scripts/github-notification-model-issue-work-scenario.ts';
import hasGitHubNotificationModelToolResult from '../../scripts/github-notification-model-tool-result.ts';

export const githubNotificationCommentAssignmentReplyCallId =
  'call_agent_system_comment_assignment_reply';
export const githubNotificationCommentIssueCallId = 'call_agent_system_github_comment_issue';
export const githubNotificationCommentPatchCallId = 'call_apply_patch_comment_fixture';
export const githubNotificationCommentAddCallId = 'call_agent_system_git_comment_add';
export const githubNotificationCommentCommitCallId = 'call_agent_system_git_comment_commit';
export const githubNotificationCommentReplyCallId = 'call_agent_system_comment_reply';

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
  'Staged one concise response for the approved GitHub comment.';

const commentReplyTokenPattern = /\bready-[0-9]+-[0-9]+\b/u;

function messageText(message: ChatCompletionRequest['messages'][number]): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
}

function commentReplyToken(request: ChatCompletionRequest): string {
  const token = request.messages.map(messageText).join('\n').match(commentReplyTokenPattern)?.[0];
  if (!token) throw new Error('The comment model request is missing its bounded reply token.');
  return token;
}

const issueWorkScenario = createGitHubNotificationIssueWorkScenario({
  assignmentFinalResponse: githubNotificationCommentAssignmentFinalResponse,
  callIds: {
    add: githubNotificationCommentAddCallId,
    commit: githubNotificationCommentCommitCallId,
    issue: githubNotificationCommentIssueCallId,
    patch: githubNotificationCommentPatchCallId,
    reply: githubNotificationCommentAssignmentReplyCallId,
  },
  candidate: githubNotificationCommentCandidate,
  commitMessage: 'add comment fixture',
  fileContents: 'comment fixture ready.',
  filenamePattern: /\bcomment-fixture-[0-9]+-[0-9]+\.txt\b/u,
  finalResponse: githubNotificationCommentImplementationFinalResponse,
  id: 'comment',
});

const commentFixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      toolName: 'agent_system_github_reply',
      userMessage: commentReplyTokenPattern,
    },
    response: (request): ToolCallResponse => ({
      id: 'agent-system-notification-comment-reply-response',
      toolCalls: [
        {
          arguments: JSON.stringify({ body: `{{commenter}}, ${commentReplyToken(request)}` }),
          id: githubNotificationCommentReplyCallId,
          name: 'agent_system_github_reply',
        },
      ],
    }),
  },
  {
    match: {
      hasToolResult: true,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasGitHubNotificationModelToolResult(
          request.messages,
          githubNotificationCommentReplyCallId,
        ),
      userMessage: commentReplyTokenPattern,
    },
    response: {
      content: githubNotificationCommentFinalResponse,
      id: 'agent-system-notification-comment-final-response',
    },
  },
];

export const commentScenario = {
  ...issueWorkScenario,
  finalResponses: [...issueWorkScenario.finalResponses, githubNotificationCommentFinalResponse],
  fixtures: [...issueWorkScenario.fixtures, ...commentFixtures],
  toolCalls: [
    ...issueWorkScenario.toolCalls,
    { id: githubNotificationCommentReplyCallId, name: 'agent_system_github_reply' },
  ],
};
