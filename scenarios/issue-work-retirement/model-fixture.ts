import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import createGitHubNotificationIssueWorkScenario from '../../scripts/github-notification-model-issue-work-scenario.ts';

export const githubNotificationRetirementReplyCallId = 'call_agent_system_retirement_reply';
export const githubNotificationRetirementIssueCallId = 'call_agent_system_github_retirement_issue';
export const githubNotificationRetirementPatchCallId = 'call_apply_patch_retirement_fixture';
export const githubNotificationRetirementAddCallId = 'call_agent_system_git_retirement_add';
export const githubNotificationRetirementCommitCallId = 'call_agent_system_git_retirement_commit';

export const githubNotificationRetirementCandidate =
  "This assignment asks for one bounded retirement fixture. I'm going to verify the prepared worktree, implement only the exact requested file when the lifecycle continues, and preserve managed resources until provider-verified completion permits cleanup.";

export const githubNotificationRetirementAssignmentFinalResponse = [
  '## Assessment',
  '',
  'The requested retirement fixture is bounded and the prepared worktree is ready for the later lifecycle transition.',
  '',
  '## Plan',
  '',
  'Create and validate only the exact fixture when implementation continues, then let provider-verified retirement determine whether managed resources are retained or cleaned up.',
].join('\n');

export const githubNotificationRetirementFinalResponse = [
  '## Implementation',
  '',
  'Created the requested completed retirement fixture with the exact assigned contents.',
  '',
  '## Validation',
  '',
  'Confirmed the bounded file change before staging it.',
  '',
  '## Delivery',
  '',
  'Created one local commit in the prepared lifecycle worktree for managed pull request delivery.',
].join('\n');

const retirementGuidedAssignmentFinalResponse =
  'The retirement checkpoint is prepared. I am waiting for operator direction before taking action.';

const retirementGuidedAssignmentSystemPromptSignals = [
  'Guided mode is operator-led',
  'The initial assignment authorizes setup and acknowledgment, not implementation',
  'do not call the tool because the deterministic assignment acknowledgment is the complete public response',
] as const;

function hasRetirementGuidedAssignmentPrompt(request: ChatCompletionRequest): boolean {
  const userText = request.messages
    .filter((message) => message.role === 'user')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  return (
    userText.includes('add retirement fixture') &&
    userText.includes('Create retirement-fixture-') &&
    !userText.includes('completed-retirement-fixture-')
  );
}

const retirementGuidedAssignmentFixture: Fixture = {
  match: {
    hasToolResult: false,
    model: /^(?:aimock\/)?gpt-5\.5$/u,
    predicate: hasRetirementGuidedAssignmentPrompt,
    systemMessage: [...retirementGuidedAssignmentSystemPromptSignals],
  },
  response: {
    content: retirementGuidedAssignmentFinalResponse,
    id: 'agent-system-notification-retirement-guided-assignment-final-response',
  },
};

const retirementWorkScenario = createGitHubNotificationIssueWorkScenario({
  assignmentFinalResponse: githubNotificationRetirementAssignmentFinalResponse,
  callIds: {
    add: githubNotificationRetirementAddCallId,
    commit: githubNotificationRetirementCommitCallId,
    issue: githubNotificationRetirementIssueCallId,
    patch: githubNotificationRetirementPatchCallId,
    reply: githubNotificationRetirementReplyCallId,
  },
  candidate: githubNotificationRetirementCandidate,
  commitMessage: 'add completed retirement fixture',
  fileContents: 'completed retirement fixture ready.',
  filenamePattern: /\bcompleted-retirement-fixture-[0-9]+-[0-9]+\.txt\b/u,
  finalResponse: githubNotificationRetirementFinalResponse,
  id: 'retirement',
});

export const retirementScenario = {
  ...retirementWorkScenario,
  finalResponses: [
    ...retirementWorkScenario.finalResponses,
    retirementGuidedAssignmentFinalResponse,
  ],
  fixtures: [retirementGuidedAssignmentFixture, ...retirementWorkScenario.fixtures],
};
