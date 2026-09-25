import assert from 'node:assert/strict';

import { matchFixture, type ChatCompletionRequest, type FixtureResponse } from '@copilotkit/aimock';

import { githubExampleTanaabotPrompt } from '../examples/github/model-fixture.ts';
import openClawAIMockEvidence from '../scripts/aimock-evidence.ts';
import resolveScenario from '../scripts/aimock-scenarios.ts';
import withToolSearch, { normalizeToolSearchRequest } from '../scripts/aimock-tool-search.ts';

function request(prompt = githubExampleTanaabotPrompt): ChatCompletionRequest {
  return {
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: prompt }],
    tools: ['tool_search', 'tool_describe', 'tool_call'].map((name) => ({
      type: 'function',
      function: { name },
    })),
  };
}

function append(request: ChatCompletionRequest, response: FixtureResponse, result: unknown): void {
  assert.ok('toolCalls' in response && response.toolCalls?.length === 1);
  const call = response.toolCalls[0]!;
  const id = `${call.id}_fc-observed_123`;
  request.messages.push(
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id, type: 'function', function: { name: call.name, arguments: call.arguments } },
      ],
    },
    { role: 'tool', tool_call_id: id, content: JSON.stringify(result) },
  );
}

function searchResult(names: string[]) {
  return {
    results: names.map((name) => ({
      query: name,
      candidates: [{ id: `openclaw:${name}`, name, source: 'openclaw', input: '{ args }' }],
    })),
  };
}

async function reply(scenario: ReturnType<typeof withToolSearch>, request: ChatCompletionRequest) {
  const fixture = matchFixture([...scenario.fixtures], request);
  assert.ok(fixture, 'the request must match a strict fixture');
  return {
    fixture,
    response:
      typeof fixture.response === 'function' ? await fixture.response(request) : fixture.response,
  };
}

describe('scripts/aimock-tool-search', () => {
  it('should discover and call the real catalog id before accepting the github result', async () => {
    const scenario = withToolSearch(resolveScenario('github'));
    const input = request();
    const entries: Parameters<typeof openClawAIMockEvidence>[1][number][] = [];
    const respond = async () => {
      const { fixture, response } = await reply(scenario, input);
      entries.push({
        body: structuredClone(input),
        method: 'POST',
        path: '/responses',
        response: { fixture, status: 200 },
      });
      return response;
    };
    const search = await respond();
    assert.ok('toolCalls' in search);
    assert.equal(search.toolCalls?.[0]?.name, 'tool_search');
    assert.deepEqual(JSON.parse(search.toolCalls![0]!.arguments), {
      queries: [{ query: 'agent_system_github', limit: 1 }],
    });
    append(input, search, searchResult(['agent_system_github']));
    const call = await respond();
    assert.ok('toolCalls' in call);
    assert.equal(call.toolCalls?.[0]?.name, 'tool_call');
    assert.deepEqual(JSON.parse(call.toolCalls![0]!.arguments), {
      id: 'openclaw:agent_system_github',
      args: { argv: ['api', 'user', '--jq', '.login'] },
    });
    append(input, call, {
      tool: { id: 'openclaw:agent_system_github', name: 'agent_system_github', source: 'openclaw' },
      result: { content: [{ type: 'text', text: 'tanaabot' }] },
    });
    assert.deepEqual(await respond(), {
      content: 'tanaabot',
      id: 'call_example_github_tanaabot_final_response',
    });
    const evidence = openClawAIMockEvidence(scenario, entries);
    assert.equal(evidence.discoveryRequestCount, 1);
    assert.equal(evidence.requestCount, 3);
    assert.equal(evidence.finalResponseCount, 1);
    assert.deepEqual(evidence.tools, [
      {
        name: 'agent_system_github',
        callResponseCount: 1,
        projectionRequestCount: 2,
        resultRequestCount: 1,
      },
    ]);
  });

  it('should reject absent tools and results for a different or failed target', async () => {
    const scenario = withToolSearch(resolveScenario('github'));
    const missing = request();
    append(missing, (await reply(scenario, missing)).response, {
      results: [{ query: 'agent_system_github', candidates: [] }],
    });
    assert.equal(matchFixture([...scenario.fixtures], missing), null);
    for (const wrong of [
      {
        tool: { id: 'openclaw:agent_system_github', name: 'other' },
        result: { content: [{ type: 'text', text: 'tanaabot' }] },
      },
      {
        tool: { id: 'other', name: 'agent_system_github' },
        result: { content: [{ type: 'text', text: 'tanaabot' }] },
      },
      {
        tool: { id: 'openclaw:agent_system_github', name: 'agent_system_github' },
        result: { isError: true, content: [{ type: 'text', text: 'tanaabot' }] },
      },
    ]) {
      const input = request();
      append(input, (await reply(scenario, input)).response, searchResult(['agent_system_github']));
      append(input, (await reply(scenario, input)).response, wrong);
      assert.throws(() => normalizeToolSearchRequest(input));
    }
  });

  it('should recheck discovery on a later turn before applying session permission assertions', async () => {
    const scenario = withToolSearch(resolveScenario('operator-access'));
    const input = request('operator-access unflagged control');
    input.messages.unshift({
      role: 'system',
      content: 'This is the initial turn for an assigned issue',
    });
    append(input, (await reply(scenario, input)).response, {
      results: [{ query: 'sessions', candidates: [] }],
    });
    assert.ok('content' in (await reply(scenario, input)).response);
    input.messages.push({ role: 'user', content: 'operator-access denied control' });
    const search = (await reply(scenario, input)).response;
    assert.ok('toolCalls' in search);
    append(input, search, searchResult(['sessions']));
    await assert.rejects(reply(scenario, input), /non-owner or denied turn received sessions/u);
  });

  it('should preserve direct calls and the explicitly tool-free readiness turn', async () => {
    const github = withToolSearch(resolveScenario('github'));
    const direct = request();
    direct.tools = [{ type: 'function', function: { name: 'agent_system_github' } }];
    const call = (await reply(github, direct)).response;
    assert.ok('toolCalls' in call);
    assert.equal(call.toolCalls?.[0]?.name, 'agent_system_github');
    const ready = request('Acknowledge readiness without using tools.');
    ready.messages.unshift({ role: 'system', content: 'Name: Data' });
    assert.deepEqual((await reply(withToolSearch(resolveScenario('agent')), ready)).response, {
      content: 'Ready.',
      id: 'agent-system-example-agent-final-response',
    });
  });

  it('should pass verified inner json to the next routing step without losing its digest', async () => {
    const scenario = withToolSearch(resolveScenario('agent'));
    const input = request(
      'Inspect model routing and resolve an unspecified task using the configured default.',
    );
    append(
      input,
      (await reply(scenario, input)).response,
      searchResult(['agent_system_model_routing']),
    );
    const inspect = (await reply(scenario, input)).response;
    append(input, inspect, {
      tool: { id: 'openclaw:agent_system_model_routing', name: 'agent_system_model_routing' },
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'available', manifestDigest: 'current-digest' }),
          },
        ],
      },
    });
    const resolve = (await reply(scenario, input)).response;
    assert.ok('toolCalls' in resolve && resolve.toolCalls?.length === 1);
    const call = resolve.toolCalls[0]!;
    assert.equal(call.name, 'tool_call');
    assert.equal(JSON.parse(call.arguments).args.manifestDigest, 'current-digest');
    append(input, resolve, {
      tool: { id: 'openclaw:agent_system_model_routing', name: 'agent_system_model_routing' },
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'unresolved',
              profile: 'default',
              reason: 'No defensible tier.',
              selection: { model: 'aimock/gpt-5.5', effort: 'medium' },
              application: 'not-requested',
            }),
          },
        ],
      },
    });
    assert.deepEqual((await reply(scenario, input)).response, {
      id: 'agent-routing-final',
      content: 'routing-default-ready',
    });
  });
});
