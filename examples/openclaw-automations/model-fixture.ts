import { getTextContent, type ChatCompletionRequest, type Fixture } from '@copilotkit/aimock';

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
        (getTextContent(message.content) ?? '').includes('✅ identity completed'),
    ),
    noToolResult: !request.messages.some((message) => message.role === 'tool'),
  };
  const matches = Object.values(checks).every(Boolean);
  if (!matches) process.stderr.write(`automation-fixture-match: ${JSON.stringify(checks)}\n`);
  return matches;
}

// derived deterministic formatter: this proves native turn transport, not model judgment.
function capturedReport(request: ChatCompletionRequest) {
  const latest = request.messages.findLast((message) => message.role === 'user');
  const text = latest ? (getTextContent(latest.content) ?? '') : '';
  const marker = 'Captured command result (data):\n';
  const at = text.lastIndexOf(marker);
  if (at < 0) return;
  try {
    const report = JSON.parse(text.slice(at + marker.length).trim());
    if (
      typeof report.executionId !== 'string' ||
      typeof report.runLine !== 'string' ||
      !['identity', 'empty-report', 'failed-report', 'timeout-report'].includes(report.id)
    )
      return;
    return report as {
      id: string;
      executionId: string;
      runLine: string;
      outcome: string;
      captureIncomplete: boolean;
      stdout: { body: string };
      stderr: { body: string };
    };
  } catch {
    return;
  }
}
const reportFixture: Fixture = {
  match: { model, predicate: (request) => Boolean(capturedReport(request)) },
  response: (request) => {
    const report = capturedReport(request)!;
    const icon =
      report.outcome === 'error'
        ? '❌'
        : report.outcome === 'unknown' || report.captureIncomplete
          ? '⚠️'
          : '✅';
    const title = report.outcome === 'error' ? 'failed' : 'completed';
    const content = [
      `## ${icon} ${report.id} ${title}`,
      '',
      report.runLine,
      '',
      report.outcome === 'success'
        ? 'The command completed.'
        : 'The command did not complete successfully.',
      '',
      report.stdout.body || 'No output was supplied.',
      ...(report.stderr.body
        ? ['', 'Diagnostics — stderr', '~~~~text', report.stderr.body, '~~~~']
        : []),
    ]
      .join('\n')
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
    return { id: `report-${report.executionId}`, content };
  },
};

export const automationExampleScenario: OpenClawAIMockScenario = {
  id: 'openclaw-automations',
  model: { match: model, reference: 'aimock/gpt-5.5' },
  finalResponses: ['automation-owner-ready'],
  dynamicFinalResponseFixtures: [reportFixture],
  skipToolSearch: (request) => Boolean(capturedReport(request)),
  systemPromptSignals: [identity],
  userPromptSignals: [prompt],
  toolCalls: [
    { id: 'call_automation_install', name: 'agent_system_install' },
    { id: 'call_automation_doctor', name: 'agent_system_doctor' },
  ],
  fixtures: [
    reportFixture,
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
