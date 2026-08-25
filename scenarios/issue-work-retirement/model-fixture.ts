import type { Fixture } from '@copilotkit/aimock';

import hasGitHubNotificationModelToolResult from '../../scripts/github-notification-model-tool-result.ts';

export const githubNotificationRetirementCallId = 'call_agent_system_retirement_reply';

export const githubNotificationRetirementCandidate =
  "This assignment asks for a small retirement fixture. I'm going to assess the prepared worktree and plan the bounded change before the later unassignment proves that retirement preserves managed worktree ownership.";

export const githubNotificationRetirementFinalResponse = [
  '## Assessment',
  '',
  'The requested retirement fixture is bounded and the prepared worktree is ready for the later lifecycle transition.',
  '',
  '## Plan',
  '',
  'Keep this turn planning-only, then verify that removing the assignment retires the lifecycle without deleting its managed worktree.',
].join('\n');

const retirementPromptSignals = [
  'Continue the current GitHub issue lifecycle',
  'This is the initial planning turn for an assigned issue',
  'Before your final response, call `agent_system_github_reply` exactly once',
] as const;

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      systemMessage: [...retirementPromptSignals],
      toolName: 'agent_system_github_reply',
    },
    response: {
      id: 'agent-system-notification-retirement-tool-response',
      toolCalls: [
        {
          arguments: JSON.stringify({ body: githubNotificationRetirementCandidate }),
          id: githubNotificationRetirementCallId,
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
        hasGitHubNotificationModelToolResult(request.messages, githubNotificationRetirementCallId),
      systemMessage: [...retirementPromptSignals],
    },
    response: {
      content: githubNotificationRetirementFinalResponse,
      id: 'agent-system-notification-retirement-final-response',
    },
  },
];

export const retirementScenario = {
  finalResponses: [githubNotificationRetirementFinalResponse],
  fixtures,
  id: 'retirement',
  model: {
    match: /^(?:aimock\/)?gpt-5\.5$/u,
    reference: 'aimock/gpt-5.5',
  },
  promptSignals: retirementPromptSignals,
  toolCalls: [
    {
      id: githubNotificationRetirementCallId,
      name: 'agent_system_github_reply',
    },
  ],
};
