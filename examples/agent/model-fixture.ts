import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';
import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

export const agentExampleFinalResponse = 'Ready.';

const agentSystemPromptSignals = ['Name: Data'] as const;
const agentUserPromptSignals = ['Acknowledge readiness without using tools.'] as const;

function hasAgentPrompt(request: ChatCompletionRequest): boolean {
  const userText = request.messages
    .filter((message) => message.role === 'user')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  return agentUserPromptSignals.every((signal) => userText.includes(signal));
}

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      predicate: hasAgentPrompt,
      systemMessage: [...agentSystemPromptSignals],
    },
    response: {
      content: agentExampleFinalResponse,
      id: 'agent-system-example-agent-final-response',
    },
  },
];

const routingPrompt =
  'Inspect model routing and resolve an unspecified task using the configured default.';
const inspectCall = 'call_agent_routing_inspect';
const resolveCall = 'call_agent_routing_resolve';
const routingReady = 'routing-default-ready';
function routingRequest(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === 'user' && getTextContent(message.content)?.includes(routingPrompt),
  );
}
function routingResult(
  request: ChatCompletionRequest,
  callId: string,
): Record<string, unknown> | undefined {
  const text = openClawAIMockToolResultText(request.messages, callId);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
fixtures.push(
  {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      hasToolResult: false,
      toolName: 'agent_system_model_routing',
      predicate: routingRequest,
    },
    response: {
      id: 'agent-routing-inspect',
      toolCalls: [
        { id: inspectCall, name: 'agent_system_model_routing', arguments: '{"action":"inspect"}' },
      ],
    },
  },
  {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      hasToolResult: true,
      predicate: (request) =>
        routingRequest(request) &&
        routingResult(request, inspectCall)?.status === 'available' &&
        !routingResult(request, resolveCall),
    },
    response: (request) => ({
      id: 'agent-routing-resolve',
      toolCalls: [
        {
          id: resolveCall,
          name: 'agent_system_model_routing',
          arguments: JSON.stringify({
            action: 'resolve',
            manifestDigest: routingResult(request, inspectCall)!.manifestDigest,
            context: 'An unspecified task.',
            assessment: { complexity: 'unset', reason: 'No defensible tier.' },
            fallback: 'default',
          }),
        },
      ],
    }),
  },
  {
    match: {
      model: /^(?:aimock\/)?gpt-5\.5$/u,
      hasToolResult: true,
      predicate: (request) => {
        const result = routingResult(request, resolveCall);
        const selection = result?.selection as Record<string, unknown> | undefined;
        return (
          routingRequest(request) &&
          result?.status === 'unresolved' &&
          result.profile === 'default' &&
          result.reason === 'No defensible tier.' &&
          selection?.model === 'aimock/gpt-5.5' &&
          selection.effort === 'medium' &&
          result.application === 'not-requested'
        );
      },
    },
    response: { id: 'agent-routing-final', content: routingReady },
  },
);

export const agentExampleScenario: OpenClawAIMockScenario = {
  skipToolSearch: hasAgentPrompt,
  finalResponses: [agentExampleFinalResponse, routingReady],
  fixtures,
  id: 'agent',
  model: {
    match: /^(?:aimock\/)?gpt-5\.5$/u,
    reference: 'aimock/gpt-5.5',
  },
  systemPromptSignals: agentSystemPromptSignals,
  toolCalls: [
    { id: inspectCall, name: 'agent_system_model_routing' },
    { id: resolveCall, name: 'agent_system_model_routing' },
  ],
  userPromptSignals: agentUserPromptSignals,
};
