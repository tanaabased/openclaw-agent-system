import assert from 'node:assert/strict';
import { LLMock } from '@copilotkit/aimock';

import { issuePickupScenario } from '../examples/openclaw-project-picker/model-fixture.ts';
import withToolSearch from '../scripts/aimock-tool-search.ts';

describe('issue pickup model transport', () => {
  it('should complete the hosted assessment through http responses and searchable tools', async () => {
    const mock = new LLMock({ host: '127.0.0.1', port: 0, strict: true, logLevel: 'warn' });
    mock.addFixtures([...withToolSearch(issuePickupScenario).fixtures]);
    const base = await mock.start();
    const id = 'a'.repeat(64);
    const input: unknown[] = [
      {
        role: 'user',
        content: `Call agent_system_dispatch with action context and id ${id}`,
      },
    ];
    const request = async () => {
      const response = await fetch(`${base}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4-nano',
          input,
          stream: false,
          tools: ['tool_search', 'tool_call'].map((name) => ({
            type: 'function',
            name,
            parameters: { type: 'object' },
          })),
        }),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await response.json()) as {
        output: Array<{
          type: string;
          name: string;
          call_id: string;
          arguments: string;
          content: Array<{ text: string }>;
        }>;
      };
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.output.length, 1);
      return body.output[0]!;
    };
    const respond = (call: { call_id: string }, output: unknown) =>
      input.push(call, {
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(output),
      });
    try {
      const search = await request();
      assert.equal(search.name, 'tool_search');
      respond(search, {
        results: ['agent_system_intake', 'agent_system_dispatch'].map((name) => ({
          query: name,
          candidates: [{ id: `openclaw:${name}`, name, source: 'openclaw', input: '{ args }' }],
        })),
      });
      const context = await request();
      assert.equal(context.name, 'tool_call');
      assert.deepEqual(JSON.parse(context.arguments), {
        id: 'openclaw:agent_system_dispatch',
        args: { action: 'context', id },
      });
      respond(context, {
        tool: { id: 'openclaw:agent_system_dispatch', name: 'agent_system_dispatch' },
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'verified',
                mode: 'work',
                project: { path: '/fixture/issue' },
              }),
            },
          ],
        },
      });
      const final = await request();
      assert.equal(final.type, 'message');
      assert.equal(
        final.content[0]!.text,
        'Should disposable issues close after evidence capture?',
      );
      assert.ok(
        mock.getRequests().every((entry) => entry.method === 'POST' && entry.response.fixture),
      );
    } finally {
      await mock.stop();
    }
  });
});
