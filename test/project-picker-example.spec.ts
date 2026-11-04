import assert from 'node:assert/strict';

import { type ChatCompletionRequest, type FixtureResponse } from '@copilotkit/aimock';

import { assessmentResultContextSchema } from '../agent/assessment-result.ts';
import { pickupResponse } from '../examples/openclaw-project-picker/model-fixture.ts';

function request(prompt: string, results: Array<[string, unknown]> = []): ChatCompletionRequest {
  return {
    model: 'gpt-5.5',
    messages: [
      { role: 'user', content: prompt },
      ...results.map(([id, value]) => ({
        role: 'tool' as const,
        tool_call_id: `call_pickup_${id}-0`,
        content: JSON.stringify(value),
      })),
    ],
  };
}
function argumentsOf(response: FixtureResponse | undefined) {
  assert.ok(response && 'toolCalls' in response && response.toolCalls?.length === 1);
  return JSON.parse(response.toolCalls[0]!.arguments);
}

const prompt = 'Run the activated project pickup once.';

describe('examples/openclaw-project-picker model fixture', () => {
  it('should select the supplied candidate through intake using the native snapshot identifiers', () => {
    const selection = argumentsOf(
      pickupResponse(
        request(prompt, [
          [
            'scan-0',
            {
              status: 'selection-required',
              id: 'native-scan',
              digest: 'native-digest',
              guidance: 'Prefer the bounded cleanup clarification.',
              candidates: [
                { nodeId: 'larger-issue', body: 'Redesign everything.' },
                { nodeId: 'small-issue', body: 'pickup-cleanup-clarification' },
              ],
            },
          ],
        ]),
      ),
    );
    assert.deepEqual(selection, {
      action: 'pickup',
      selection: {
        id: 'native-scan',
        digest: 'native-digest',
        issueNodeId: 'small-issue',
        shortlist: ['larger-issue', 'small-issue'],
        rationale: 'The bounded cleanup clarification is smaller than the redesign.',
      },
    });
  });

  it('should preserve terminal cards and refuse to conceal failed or uncertain assignments', () => {
    for (const status of ['empty', 'assigned', 'allowance-reached']) {
      const response = `📥 ${status} native card`;
      assert.deepEqual(pickupResponse(request(prompt, [['scan-0', { status, response }]])), {
        content: response,
      });
    }
    for (const status of ['failed', 'attempted', 'blocked']) {
      assert.throws(() =>
        pickupResponse(request(prompt, [['scan-0', { status, code: 'native-failure' }]])),
      );
    }
  });

  it('should keep prior scan results out of the next native turn', () => {
    const input = request(prompt, [['scan-0', { status: 'empty', response: '📥 empty' }]]);
    input.messages.push({ role: 'user', content: prompt });
    assert.deepEqual(argumentsOf(pickupResponse(input)), { action: 'pickup' });
  });

  it('should retry only recognized contention with the same operation and a bounded budget', () => {
    const input = request(prompt, [
      ['scan-0', { status: 'busy', code: 'private-state-file-lock-busy' }],
    ]);
    const response = pickupResponse(input);
    assert.deepEqual(argumentsOf(response), { action: 'pickup' });
    assert.ok(response && 'toolCalls' in response);
    assert.equal(response.toolCalls![0]!.id, 'call_pickup_scan-0-1');
    for (let attempt = 1; attempt <= 3; attempt++)
      input.messages.push({
        role: 'tool',
        tool_call_id: `call_pickup_scan-0-${attempt}`,
        content: JSON.stringify({ status: 'busy', code: 'private-state-file-lock-busy' }),
      });
    assert.throws(() => pickupResponse(input), /contention exhausted/u);
  });

  it('should require ordinary intake to supply work mode before retaining clarification', () => {
    const id = 'a'.repeat(64);
    const context = {
      status: 'verified',
      mode: 'work',
      project: { path: '/fixture/issue' },
      resultSchema: assessmentResultContextSchema,
      resultSubmission: { request: { action: 'result', id }, resultField: 'result' },
    };
    const input = request(`Call agent_system_dispatch with action context and id ${id}`, [
      ['context', context],
    ]);
    const saved = argumentsOf(pickupResponse(input));
    assert.equal(saved.id, id);
    assert.equal(saved.action, 'result');
    assert.equal(saved.result.outcome, 'clarification-needed');
    assert.ok(saved.result.questions.length > 0);
    assert.throws(
      () =>
        pickupResponse(
          request(`Call agent_system_dispatch with action context and id ${id}`, [
            ['context', { ...context, mode: 'plan' }],
          ]),
        ),
      /override ordinary plan mode/u,
    );
  });
});
