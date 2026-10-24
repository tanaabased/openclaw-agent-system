import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';
import { openClawAIMockToolResultText } from '../../scripts/aimock-tool-result.ts';

const model = /^(?:aimock\/)?gpt-5\.(?:5|4-nano)$/u;
const installCall = 'call_runtime_install';
const codexInstallCall = 'call_runtime_codex_install';
const codexDoctorCall = 'call_runtime_codex_doctor';
const doctorCall = 'call_runtime_doctor';

function userIncludes(request: ChatCompletionRequest, signal: string): boolean {
  return request.messages.some(
    ({ role, content }) => role === 'user' && getTextContent(content)?.includes(signal),
  );
}

const fixtures: Fixture[] = [
  {
    match: {
      model,
      hasToolResult: true,
      predicate: (request) => {
        const text = openClawAIMockToolResultText(request.messages, codexInstallCall);
        if (!text) return false;
        try {
          const result = JSON.parse(text);
          return result.agentId === 'runtime-codex' && Array.isArray(result.outcomes);
        } catch {
          return false;
        }
      },
    },
    response: { content: 'runtime-install-ready', id: 'runtime-install-ready-final' },
  },
  ...[
    { name: 'agent_system_install', callId: installCall, model: /^(?:aimock\/)?gpt-5\.5$/u },
    { name: 'agent_system_doctor', callId: doctorCall, model: /^(?:aimock\/)?gpt-5\.5$/u },
    { name: 'agent_system_install', callId: codexInstallCall, model: /^gpt-5\.4-nano$/u },
    { name: 'agent_system_doctor', callId: codexDoctorCall, model: /^gpt-5\.4-nano$/u },
  ].map(({ name, callId, model }): Fixture => ({
    match: {
      model,
      hasToolResult: false,
      toolName: name,
      predicate: (request) => userIncludes(request, `Call ${name} exactly once`),
    },
    response: {
      toolCalls: [{ id: callId, name, arguments: '{"timeoutMs":600000}' }],
    },
  })),
  {
    match: {
      model,
      hasToolResult: true,
      predicate: (request) => {
        const text = openClawAIMockToolResultText(
          request.messages,
          request.model.includes('5.4-nano') ? codexDoctorCall : doctorCall,
        );
        if (!text) return false;
        try {
          return Array.isArray(JSON.parse(text).findings);
        } catch {
          return false;
        }
      },
    },
    response: { content: 'runtime-doctor-ready', id: 'runtime-doctor-final' },
  },
  {
    match: {
      model,
      hasToolResult: true,
      predicate: (request) =>
        openClawAIMockToolResultText(request.messages, installCall)
          ?.toLowerCase()
          .includes('denied by user') === true,
    },
    response: { content: 'runtime-install-denied', id: 'runtime-install-final' },
  },
];

export const lifecycleApprovalScenario: OpenClawAIMockScenario = {
  id: 'openclaw-lifecycle-approvals',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  fixtures,
  finalResponses: ['runtime-install-ready', 'runtime-doctor-ready', 'runtime-install-denied'],
  expectedDeniedToolCalls: [{ id: installCall, name: 'agent_system_install' }],
  systemPromptSignals: [],
  toolCalls: [
    { id: installCall, name: 'agent_system_install' },
    { id: doctorCall, name: 'agent_system_doctor' },
    { id: codexDoctorCall, name: 'agent_system_doctor' },
    { id: codexInstallCall, name: 'agent_system_install' },
  ],
};
