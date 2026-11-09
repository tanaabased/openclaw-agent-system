import assert from 'node:assert/strict';
import type { ChatCompletionRequest } from '@copilotkit/aimock';

import captureFixtureErrors from '../scripts/aimock-fixture-errors.ts';

describe('aimock fixture error diagnostics', () => {
  it('retains result status and diagnostic codes without retaining private result prose', () => {
    const failure = new Error('private assertion detail');
    const captured = captureFixtureErrors({
      id: 'diagnostics',
      model: { match: /fixture/u, reference: 'fixture' },
      systemPromptSignals: [],
      finalResponses: [],
      toolCalls: [],
      fixtures: [
        {
          match: {
            predicate: () => {
              throw failure;
            },
          },
          response: { content: '' },
        },
      ],
    });
    const result = {
      status: 'blocked',
      code: 'material-native-response-unavailable',
      instructions: 'private context',
    };
    const wrapped = {
      tool: { source: 'openclaw', name: 'agent_system_dispatch' },
      result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
    };
    const request = {
      model: 'fixture',
      messages: [
        result,
        wrapped,
        { code: 'private prose with spaces', status: 'private status' },
      ].map((value) => ({ role: 'tool', content: JSON.stringify(value) })),
    } as ChatCompletionRequest;
    assert.throws(
      () => captured.scenario.fixtures[0]!.match.predicate!(request),
      (error) => error === failure,
    );
    const results = captured.errors[0]!.toolResults;
    for (const observed of results.slice(0, 2)) {
      assert.equal(observed.status, 'blocked');
      assert.equal(observed.code, 'material-native-response-unavailable');
    }
    assert.equal(results[2]!.code, undefined);
    assert.equal(results[2]!.status, undefined);
    assert.doesNotMatch(JSON.stringify(captured.errors), /private/u);
  });
});
