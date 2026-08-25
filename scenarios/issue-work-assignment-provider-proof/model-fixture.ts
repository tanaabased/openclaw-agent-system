import type { Fixture } from '@copilotkit/aimock';

import hasGitHubNotificationModelToolResult from '../../scripts/github-notification-model-tool-result.ts';

export const githubNotificationModelProofCallId = 'call_agent_system_notification_proof_reply';

export const githubNotificationModelProofCandidate =
  "This issue needs a deterministic notification test that keeps the real OpenClaw and GitHub lifecycle while removing live model variability. I'm going to prove one complete assignment turn with a fixed mock tool call and response, verify the resulting publication, and document the supported boundary to resolve the issue.";

export const githubNotificationModelProofFinalResponse = [
  '## Assessment',
  '',
  'The notification test needs to prove the user-visible assignment response without depending on live model capacity or wording.',
  '',
  '## Plan',
  '',
  'Run the trusted issue, work, and assignment turn through the installed Gateway, stage the fixed reply with the real Agent System tool, verify publication, and compare bounded provider evidence.',
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
      id: 'agent-system-notification-proof-tool-response',
      toolCalls: [
        {
          arguments: JSON.stringify({ body: githubNotificationModelProofCandidate }),
          id: githubNotificationModelProofCallId,
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
        hasGitHubNotificationModelToolResult(request.messages, githubNotificationModelProofCallId),
      systemMessage: [...assignmentPromptSignals],
    },
    response: {
      content: githubNotificationModelProofFinalResponse,
      id: 'agent-system-notification-proof-final-response',
    },
  },
];

export const assignmentProviderProof = {
  finalResponses: [githubNotificationModelProofFinalResponse],
  fixtures,
  id: 'assignment-provider-proof',
  model: {
    match: /^(?:aimock\/)?gpt-5\.5$/u,
    reference: 'aimock/gpt-5.5',
  },
  promptSignals: assignmentPromptSignals,
  toolCalls: [
    {
      id: githubNotificationModelProofCallId,
      name: 'agent_system_github_reply',
    },
  ],
};
