import { getTextContent, type ChatCompletionRequest } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.5$/u;
const identity = 'Name: Automation Tanaabot';
const prompt = 'Acknowledge the scheduled owning-agent context.';

function matchesPrompt(request: ChatCompletionRequest): boolean {
  const systemText = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => getTextContent(message.content) ?? '')
    .join('\n');
  const hasPrompt = request.messages.some(
    (message) =>
      message.role === 'user' && (getTextContent(message.content) ?? '').includes(prompt),
  );
  const checks = {
    model: model.test(request.model),
    identity: systemText.includes(identity),
    prompt: hasPrompt,
    reportHistory: request.messages.some(
      (message) =>
        message.role === 'assistant' &&
        (getTextContent(message.content) ?? '').includes('## Succeeded: identity'),
    ),
    noToolResult: !request.messages.some((message) => message.role === 'tool'),
  };
  const matches = Object.values(checks).every(Boolean);
  if (!matches) process.stderr.write(`automation-fixture-match: ${JSON.stringify(checks)}\n`);
  return matches;
}

export const automationExampleScenario: OpenClawAIMockScenario = {
  id: 'openclaw-automations',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  finalResponses: ['automation-owner-ready'],
  systemPromptSignals: [identity],
  userPromptSignals: [prompt],
  toolCalls: [
    { id: 'call_automation_install', name: 'agent_system_install' },
    { id: 'call_automation_doctor', name: 'agent_system_doctor' },
  ],
  fixtures: [
    {
      match: { predicate: matchesPrompt },
      response: {
        id: 'automation-install',
        toolCalls: [
          {
            id: 'call_automation_install',
            name: 'agent_system_install',
            arguments: '{"timeoutMs":600000}',
          },
        ],
      },
    },
    {
      match: {
        model,
        hasToolResult: true,
        predicate(request) {
          const text = openClawAIMockToolResultText(request.messages, 'call_automation_install');
          if (!text || openClawAIMockToolResultText(request.messages, 'call_automation_doctor'))
            return false;
          try {
            const result = JSON.parse(text);
            return result.agentId === 'automation-tanaabot' && Array.isArray(result.outcomes);
          } catch {
            return false;
          }
        },
      },
      response: {
        id: 'automation-doctor',
        toolCalls: [
          {
            id: 'call_automation_doctor',
            name: 'agent_system_doctor',
            arguments: '{"timeoutMs":600000}',
          },
        ],
      },
    },
    {
      match: {
        model,
        hasToolResult: true,
        predicate(request) {
          const text = openClawAIMockToolResultText(request.messages, 'call_automation_doctor');
          if (!text) return false;
          try {
            const result = JSON.parse(text);
            return (
              result.agentId === 'automation-tanaabot' &&
              result.status === 'healthy' &&
              Array.isArray(result.findings)
            );
          } catch {
            return false;
          }
        },
      },
      response: { id: 'automation-owner-final', content: 'automation-owner-ready' },
    },
  ],
};
