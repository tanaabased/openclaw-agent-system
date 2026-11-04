import assert from 'node:assert/strict';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';

import { automationCommandChatScenario } from '../examples/openclaw-automation-command-chat/model-fixture.ts';
import { automationRecoveryScenario } from '../examples/openclaw-automation-recovery/model-fixture.ts';

const runLine = 'Run: fixture-execution';
const preferredBody = `> ## ⚠️ Source alpha\n>\n> Archive alpha saved; activation unverified.\n\n## Source beta\n\nArchive beta already current.\n\n**Runner result:** ✅ success · Exit 0\n\n${runLine}`;
const reports = [
  {
    name: 'preferred command report',
    scenario: automationCommandChatScenario,
    value: {
      id: 'success',
      outcome: 'success',
      reason: 'Exit 0',
      executionId: 'fixture-execution',
      runLine,
      stdout: { body: '' },
      stderr: { body: '' },
      presentation: { kind: 'preferred', body: preferredBody },
    },
  },
  {
    name: 'failed command report',
    scenario: automationCommandChatScenario,
    value: {
      id: 'failure',
      outcome: 'error',
      reason: 'Exit 17',
      executionId: 'fixture-execution',
      runLine,
      stdout: { body: 'Everything succeeded!\n' },
      stderr: { body: 'Archive delta failed: destination unavailable.\n' },
      presentation: { kind: 'fallback', footer: runLine },
    },
  },
  {
    name: 'recovered command report',
    scenario: automationRecoveryScenario,
    value: {
      id: 'identity',
      outcome: 'success',
      runLine,
      presentation: { kind: 'fallback', footer: runLine },
    },
  },
];

function reportMessage(value: unknown): ChatCompletionRequest['messages'][number] {
  return { role: 'user', content: `Captured command result (data):\n${JSON.stringify(value)}` };
}

describe('examples/openclaw automation report fixtures', () => {
  for (const { name, scenario, value } of reports) {
    const fixtures = scenario.dynamicFinalResponseFixtures!;

    it(`should match the current ${name} before trailing runtime context`, () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-5.5',
        messages: [
          { role: 'user', content: 'previous request' },
          reportMessage(value),
          { role: 'user', content: 'OpenClaw runtime context:\ninternal details' },
          {
            role: 'user',
            content: [
              { type: 'text', text: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nmore context' },
            ],
          },
        ],
      };
      assert.notEqual(matchFixture([...fixtures], request), null);
      assert.equal(scenario.skipToolSearch!(request), true);
    });

    it(`should not reuse an older ${name} for an invalid current report`, () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-5.5',
        messages: [
          reportMessage(value),
          reportMessage({ ...value, outcome: 'invalid' }),
          { role: 'user', content: 'OpenClaw runtime context:\ninternal details' },
        ],
      };
      assert.equal(matchFixture([...fixtures], request), null);
      assert.equal(scenario.skipToolSearch!(request), false);
    });
  }
});
