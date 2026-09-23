import { getTextContent, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;

export const credentialExampleChecks = [
  { agentId: 'credential-data', phase: 'warm', purpose: 'primary cache warmup' },
  { agentId: 'credential-peer', phase: 'warm', purpose: 'peer cache warmup' },
  { agentId: 'credential-data', phase: 'hit', purpose: 'cache hit check' },
  { agentId: 'credential-data', phase: 'refill', purpose: 'cache refill check' },
  { agentId: 'credential-data', phase: 'mutation', purpose: 'cache mutation check' },
].map(({ agentId, phase, purpose }) => ({
  agentId,
  callId: `call_example_${agentId.replaceAll('-', '_')}_${phase}`,
  prompt: `Use the configured Git tool to report its version for the ${purpose}.`,
}));

const fixtures: Fixture[] = credentialExampleChecks.flatMap(({ callId, prompt }) => [
  {
    match: {
      hasToolResult: false,
      model,
      predicate: (request) =>
        request.messages.some(
          (message) => message.role === 'user' && getTextContent(message.content)?.includes(prompt),
        ),
      toolName: 'agent_system_git',
    },
    response: {
      id: `${callId}_tool_response`,
      toolCalls: [
        {
          arguments: JSON.stringify({ argv: ['--version'] }),
          id: callId,
          name: 'agent_system_git',
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      model,
      predicate: (request) =>
        openClawAIMockToolResultText(request.messages, callId)?.includes('git version ') === true,
    },
    response: {
      content: 'git ready',
      id: `${callId}_final_response`,
    },
  },
]);

export const credentialExampleScenario: OpenClawAIMockScenario = {
  finalResponses: ['git ready'],
  fixtures,
  id: 'credentials',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: [],
  toolCalls: credentialExampleChecks.map(({ callId }) => ({
    id: callId,
    name: 'agent_system_git',
  })),
  userPromptSignals: [],
};
