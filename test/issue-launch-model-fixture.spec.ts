import assert from 'node:assert/strict';
import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';

import { issueLaunchExampleScenario as scenario } from '../examples/openclaw-issue-launch/model-fixture.ts';

// a native refusal must remain an observed launch failure, not a fake model-service error.
describe('manual launch model fixture', () => {
  it('should stop on stale preparation without replaying it and reuse an existing owner in the next turn', async () => {
    const request: ChatCompletionRequest = {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'Name: Notification Tanaabot' },
        {
          role: 'user',
          content:
            'Manual issue launch target: https://github.com/tanaabased/big-test-bucket/issues/42',
        },
        {
          role: 'tool',
          tool_call_id: 'call_manual_launch_context_0',
          content: JSON.stringify({
            status: 'routing-required',
            id: 'a'.repeat(64),
            digest: 'd'.repeat(64),
          }),
        },
        {
          role: 'tool',
          tool_call_id: 'call_manual_launch_prepare_0',
          content: JSON.stringify({
            status: 'waiting',
            code: 'dispatch-preparation-stale',
            stage: 'validation',
          }),
        },
      ],
    };
    const respond = async () => {
      const fixture = matchFixture([...scenario.fixtures], request);
      assert.ok(fixture);
      return typeof fixture.response === 'function' ? fixture.response(request) : fixture.response;
    };
    const stopped = await respond();
    assert.ok('content' in stopped);
    assert.match(String(stopped.content), /dispatch-preparation-stale/u);
    request.messages.push(
      {
        role: 'user',
        content:
          'Manual issue launch target: https://github.com/tanaabased/big-test-bucket/issues/42',
      },
      {
        role: 'tool',
        tool_call_id: 'call_manual_launch_context_0',
        content: JSON.stringify({ status: 'existing', destination: 'original-issue-chat' }),
      },
    );
    assert.deepEqual(await respond(), { content: 'manual-launch-existing' });
  });
});
