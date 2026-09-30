import type { OpenClawAIMockScenario } from '../../scripts/aimock-scenario.ts';

export const automationExampleScenario: OpenClawAIMockScenario = {
  id: 'automations',
  model: { match: /^(?:aimock\/)?gpt-5\.5$/u, reference: 'aimock/gpt-5.5' },
  finalResponses: ['automation-owner-ready'],
  systemPromptSignals: ['Name: Automation Tanaabot'],
  userPromptSignals: ['Acknowledge the scheduled owning-agent context.'],
  toolCalls: [],
  fixtures: [
    {
      match: {
        model: /^(?:aimock\/)?gpt-5\.5$/u,
        hasToolResult: false,
        systemMessage: ['Name: Automation Tanaabot'],
        userMessage: 'Acknowledge the scheduled owning-agent context.',
      },
      response: { id: 'automation-owner-final', content: 'automation-owner-ready' },
    },
  ],
};
