import assert from 'node:assert/strict';
import type { ChatCompletionRequest } from '@copilotkit/aimock';

import captureFixtureErrors from '../scripts/aimock-fixture-errors.ts';

describe('aimock fixture error diagnostics', () => {
  it('should retain result status and diagnostic codes without retaining private result prose', () => {
    const failure = new Error('private assertion detail');
    failure.stack = `${failure.name}: ${failure.message}\n    at fixture (/private/tmp/fixture.ts:1:1)`;
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
      providerDiagnostic: {
        provider: 'github',
        operation: 'api-request',
        classification: 'rate-limit',
        httpStatus: 403,
        retryAfterMs: 12000,
        quotaScope: 'core',
        providerMessage: 'API rate limit exceeded token=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
        extra: 'private context',
      },
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
      assert.equal(observed.providerDiagnostic?.httpStatus, 403);
      assert.equal(observed.providerDiagnostic?.classification, 'rate-limit');
      assert.equal(observed.providerDiagnostic?.retryAfterMs, 12000);
      assert.match(observed.providerDiagnostic?.providerMessage ?? '', /API rate limit exceeded/u);
    }
    assert.equal(results[2]!.code, undefined);
    assert.equal(results[2]!.status, undefined);
    assert.deepEqual(captured.errors[0]!.frames, ['    at fixture (/private/tmp/fixture.ts:1:1)']);
    assert.doesNotMatch(
      JSON.stringify(captured.errors),
      /private (?:assertion detail|context|prose with spaces|status)|ghp_abcdefghijklmnopqrstuvwxyz1234567890/u,
    );
  });
});
