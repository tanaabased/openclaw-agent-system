import { getTextContent, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;

export const diagnosticExampleCallId = 'call_example_quota_diagnostic';
export const diagnosticExamplePrompt =
  'Use the configured Git tool to report its version for the synthetic provider diagnostic check.';

const fixtures: Fixture[] = [
  {
    match: {
      hasToolResult: false,
      model,
      toolName: 'agent_system_git',
      predicate: (request) =>
        request.messages.some(
          (message) =>
            message.role === 'user' &&
            getTextContent(message.content)?.includes(diagnosticExamplePrompt),
        ),
    },
    response: {
      id: 'quota_tool_response',
      toolCalls: [
        {
          id: diagnosticExampleCallId,
          name: 'agent_system_git',
          arguments: JSON.stringify({ argv: ['--version'] }),
        },
      ],
    },
  },
  {
    match: {
      hasToolResult: true,
      model,
      predicate: (request) => {
        const result =
          openClawAIMockToolResultText(request.messages, diagnosticExampleCallId) ?? '';
        return (
          result.includes('provider="1password"') &&
          result.includes('classification="rate-limit"') &&
          result.includes('httpStatus="unknown"') &&
          result.includes('resetAt="unknown"') &&
          !/SYNTHETIC_PRIVATE|op:\/\/synthetic|Authorization:/.test(result)
        );
      },
    },
    response: { id: 'quota_final_response', content: 'quota reported' },
  },
];

export const diagnosticExampleScenario: OpenClawAIMockScenario = {
  finalResponses: ['quota reported'],
  fixtures,
  id: 'diagnostics',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  systemPromptSignals: [],
  toolCalls: [{ id: diagnosticExampleCallId, name: 'agent_system_git' }],
  userPromptSignals: [],
};
