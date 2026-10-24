import assert from 'node:assert/strict';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';

import { openClawCollaborationScenario } from '../examples/openclaw-collaboration/model-fixture.ts';

function response(request: ChatCompletionRequest) {
  return matchFixture([...openClawCollaborationScenario.fixtures], request)?.response;
}

describe('collaboration model fixture', () => {
  for (const [version, context] of [
    [
      'legacy',
      '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsourceTool=sessions_send\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
    ],
    [
      'current',
      'OpenClaw runtime context:\nsourceTool=sessions_send\nEnd OpenClaw runtime context.',
    ],
  ]) {
    it(`should answer the current peer input after ${version} runtime context`, () => {
      assert.deepEqual(
        response({
          model: 'gpt-5.5',
          messages: [
            { role: 'system', content: 'Name: Beta' },
            { role: 'user', content: 'collaboration-ready' },
            { role: 'assistant', content: 'collaboration-ready' },
            { role: 'user', content: 'collaboration-ping' },
            { role: 'user', content: context! },
          ],
        }),
        { content: 'collaboration-pong' },
      );
    });

    it(`should require a successful native send result across ${version} runtime context`, () => {
      const request: ChatCompletionRequest = {
        model: 'gpt-5.5',
        messages: [
          { role: 'system', content: 'Name: Alpha' },
          { role: 'user', content: 'collaboration-send' },
          {
            role: 'tool',
            tool_call_id: 'call_collaboration_send',
            content: JSON.stringify({ status: 'ok', reply: 'collaboration-pong' }),
          },
          { role: 'user', content: context! },
        ],
      };
      assert.deepEqual(response(request), { content: 'collaboration-exchange-complete' });
      request.messages[2]!.content = JSON.stringify({ status: 'error', error: 'peer unavailable' });
      assert.equal(response(request), undefined);
    });
  }
});
