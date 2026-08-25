import type { Fixture } from '@copilotkit/aimock';

import hasGitHubNotificationModelToolResult from '../../scripts/github-notification-model-tool-result.ts';

export const githubNotificationAssignmentCallId = 'call_agent_system_assignment_reply';

export const githubNotificationAssignmentCandidate =
  "This assignment asks for a small repository fixture. I'm going to assess the request, inspect the prepared worktree, and propose an implementation plan without changing files during this planning turn.";

export const githubNotificationAssignmentFinalResponse = [
  '## Assessment',
  '',
  'The requested fixture is bounded and the prepared worktree is ready for implementation after this planning checkpoint.',
  '',
  '## Plan',
  '',
  'Create the requested root fixture with the exact contents, verify the worktree change, and deliver it through the assigned issue lifecycle.',
].join('\n');

const assignmentPromptSignals = [
  'Continue the current GitHub issue lifecycle',
  'This is the initial planning turn for an assigned issue',
  'Before your final response, call `agent_system_github_reply` exactly once',
] as const;

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      systemMessage: [...assignmentPromptSignals],
      toolName: 'agent_system_github_reply',
    },
    response: {
      id: 'agent-system-notification-assignment-tool-response',
      toolCalls: [
        {
          arguments: JSON.stringify({ body: githubNotificationAssignmentCandidate }),
          id: githubNotificationAssignmentCallId,
          name: 'agent_system_github_reply',
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasGitHubNotificationModelToolResult(request.messages, githubNotificationAssignmentCallId),
      systemMessage: [...assignmentPromptSignals],
    },
    response: {
      content: githubNotificationAssignmentFinalResponse,
      id: 'agent-system-notification-assignment-final-response',
    },
  },
];

export const assignmentScenario = {
  finalResponses: [githubNotificationAssignmentFinalResponse],
  fixtures,
  id: 'assignment',
  model: {
    match: /^(?:aimock\/)?gpt-5\.5$/u,
    reference: 'aimock/gpt-5.5',
  },
  promptSignals: assignmentPromptSignals,
  toolCalls: [
    {
      id: githubNotificationAssignmentCallId,
      name: 'agent_system_github_reply',
    },
  ],
};
