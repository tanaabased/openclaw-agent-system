import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import hasOpenClawAIMockToolResult, {
  openClawAIMockToolResultText,
} from '../../scripts/aimock-tool-result.ts';

export const githubNotificationAssignmentCallId = 'call_agent_system_assignment_reply';
export const githubNotificationAssignmentOwnerCallId = 'call_assignment_session_owner';
export const githubNotificationAssignmentColorCallId = 'call_assignment_session_color';
export const githubNotificationAssignmentGroupsCallId = 'call_assignment_session_groups';

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

const assignmentSystemPromptSignals = [
  'Continue the current GitHub issue lifecycle',
  'This is the initial turn for an assigned issue',
  'The trusted OpenClaw agent ID for this assignment is "notification-data"',
  'bugs red',
  '"group_list"',
  '"GitHub Issues"',
  'In a mode that advances automatically, call `agent_system_github_reply` exactly once',
] as const;

const assignmentUserPromptSignals = [
  'bug: add assignment planning fixture',
  'Create assignment-planning-',
  'assignment planning ready.',
] as const;

function hasAssignmentUserPrompt(request: ChatCompletionRequest): boolean {
  const userText = request.messages
    .filter((message) => message.role === 'user')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  return assignmentUserPromptSignals.every((signal) => userText.includes(signal));
}

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: hasAssignmentUserPrompt,
      systemMessage: [...assignmentSystemPromptSignals],
      toolName: 'sessions',
    },
    response: {
      id: 'agent-system-notification-assignment-groups-response',
      toolCalls: [
        {
          arguments: JSON.stringify({ action: 'group_list' }),
          id: githubNotificationAssignmentGroupsCallId,
          name: 'sessions',
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasAssignmentUserPrompt(request) &&
        hasOpenClawAIMockToolResult(request.messages, githubNotificationAssignmentGroupsCallId) &&
        !hasOpenClawAIMockToolResult(request.messages, githubNotificationAssignmentColorCallId),
      systemMessage: [...assignmentSystemPromptSignals],
      toolName: 'sessions',
    },
    response: (request) => {
      const result = JSON.parse(
        openClawAIMockToolResultText(request.messages, githubNotificationAssignmentGroupsCallId) ??
          '',
      ) as { groups: Array<{ name: string }> };
      const group = result.groups.some((entry) => entry.name === 'Active Work')
        ? 'Active Work'
        : 'GitHub Issues';
      return {
        id: 'agent-system-notification-assignment-tool-response',
        toolCalls: [
          {
            arguments: JSON.stringify({
              action: 'assign_owner',
              ownerType: 'agent',
              ownerId: 'notification-data',
            }),
            id: githubNotificationAssignmentOwnerCallId,
            name: 'sessions',
          },
          {
            arguments: JSON.stringify({ action: 'patch', color: 'red', group }),
            id: githubNotificationAssignmentColorCallId,
            name: 'sessions',
          },
          {
            arguments: JSON.stringify({ body: githubNotificationAssignmentCandidate }),
            id: githubNotificationAssignmentCallId,
            name: 'agent_system_github_reply',
          },
        ],
      };
    },
  },
  {
    match: {
      hasToolResult: true,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: (request) =>
        hasAssignmentUserPrompt(request) &&
        [
          githubNotificationAssignmentCallId,
          githubNotificationAssignmentOwnerCallId,
          githubNotificationAssignmentColorCallId,
          githubNotificationAssignmentGroupsCallId,
        ].every((id) => hasOpenClawAIMockToolResult(request.messages, id)),
      systemMessage: [...assignmentSystemPromptSignals],
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
  systemPromptSignals: assignmentSystemPromptSignals,
  toolCalls: [
    {
      id: githubNotificationAssignmentCallId,
      name: 'agent_system_github_reply',
    },
    { id: githubNotificationAssignmentOwnerCallId, name: 'sessions' },
    { id: githubNotificationAssignmentColorCallId, name: 'sessions' },
    { id: githubNotificationAssignmentGroupsCallId, name: 'sessions' },
  ],
  userPromptSignals: assignmentUserPromptSignals,
};
