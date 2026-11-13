import assert from 'node:assert/strict';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';

import { automationRecoveryScenario } from '../examples/openclaw-automation-recovery/model-fixture.ts';

const report = (footer: string) =>
  'Captured command result (data):\n<captured_result>\n' +
  JSON.stringify({
    id: 'identity',
    outcome: 'success',
    runLine: footer,
    presentation: { kind: 'fallback', footer },
  }) +
  '\n</captured_result>';
const context = 'OpenClaw runtime context:\nCurrent runtime facts.\nEnd OpenClaw runtime context.';
const request = (...contents: string[]): ChatCompletionRequest => ({
  model: 'gpt-5.5',
  messages: contents.map((content) => ({ role: 'user', content })),
});
const matches = (input: ChatCompletionRequest) =>
  matchFixture([...automationRecoveryScenario.dynamicFinalResponseFixtures!], input);

describe('examples/openclaw-automation-recovery/model-fixture', () => {
  it('should select the current report through trailing runtime context', async () => {
    const input = request(
      report('old run'),
      report('current run'),
      '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nprivate context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
      context,
    );
    const fixture = matches(input);
    assert.ok(fixture);
    const response =
      typeof fixture.response === 'function' ? await fixture.response(input) : fixture.response;
    assert.ok('content' in response);
    assert.ok(response.content?.includes('current run'));
    assert.ok(!response.content?.includes('old run'));
    assert.equal(automationRecoveryScenario.skipToolSearch?.(input), true);
  });

  it('should not reuse report history for a later prompt or malformed report', () => {
    for (const current of [
      'Acknowledge the scheduled owning-agent context.',
      'Captured command result (data):\n<captured_result>\ninvalid\n</captured_result>',
    ]) {
      const input = request(report('old run'), current, context);
      assert.equal(matches(input), null);
      assert.equal(automationRecoveryScenario.skipToolSearch?.(input), false);
    }
  });

  it('should still match a report without runtime context', () => {
    assert.ok(matches(request(report('current run'))));
  });
});
