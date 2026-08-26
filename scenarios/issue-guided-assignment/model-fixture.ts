import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

export const githubNotificationGuidedAssignmentFinalResponse =
  'The assignment context is prepared. I am waiting for operator direction before taking action.';

const guidedAssignmentSystemPromptSignals = [
  'Guided mode is operator-led',
  'The initial assignment authorizes setup and acknowledgment, not implementation',
  'do not call the tool because the deterministic assignment acknowledgment is the complete public response',
] as const;

const guidedAssignmentUserPromptSignals = [
  'guided assignment fixture',
  'Do not create guided-assignment-',
  'until an operator gives explicit direction.',
] as const;

function hasGuidedAssignmentUserPrompt(request: ChatCompletionRequest): boolean {
  const userText = request.messages
    .filter((message) => message.role === 'user')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  return guidedAssignmentUserPromptSignals.every((signal) => userText.includes(signal));
}

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: hasGuidedAssignmentUserPrompt,
      systemMessage: [...guidedAssignmentSystemPromptSignals],
    },
    response: {
      content: githubNotificationGuidedAssignmentFinalResponse,
      id: 'agent-system-notification-guided-assignment-final-response',
    },
  },
];

export const guidedAssignmentScenario = {
  finalResponses: [githubNotificationGuidedAssignmentFinalResponse],
  fixtures,
  id: 'guided-assignment',
  model: {
    match: /^(?:aimock\/)?gpt-5\.5$/u,
    reference: 'aimock/gpt-5.5',
  },
  systemPromptSignals: guidedAssignmentSystemPromptSignals,
  toolCalls: [],
  userPromptSignals: guidedAssignmentUserPromptSignals,
};
