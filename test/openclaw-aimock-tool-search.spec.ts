import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { matchFixture, type ChatCompletionRequest, type FixtureResponse } from '@copilotkit/aimock';
import { Value } from 'typebox/value';

import { githubExampleTanaabotPrompt } from '../examples/openclaw-github/model-fixture.ts';
import openClawAIMockEvidence from '../scripts/aimock-evidence.ts';
import resolveScenario from '../scripts/example-model-scenarios.ts';
import withToolSearch, { normalizeToolSearchRequest } from '../scripts/aimock-tool-search.ts';
import { dispatchParameters } from '../tools/dispatch/tool-schema.ts';

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
  const id = `${call.id}_fc-observed_${request.messages.length}`;
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
  it('should carry notification assessment and operator delivery through wrapped tools and retained history', async () => {
    // test the pinned host's actual projection without importing it into plugin runtime code.
    const hostRequire = createRequire(
      createRequire(import.meta.url).resolve('openclaw/plugin-sdk/plugin-entry'),
    );
    const { normalizeToolParameterSchema } = await import(
      hostRequire.resolve('@openclaw/ai/internal/tool-schema')
    );
    const normalizedDispatch = normalizeToolParameterSchema(dispatchParameters, {
      modelProvider: 'aimock',
      modelId: 'gpt-5.5',
    });
    const scenario = withToolSearch(resolveScenario('openclaw-pr'));
    const id = 'a'.repeat(64);
    const digest = 'b'.repeat(64);
    const input = request(
      `Agent System: assess this admitted issue and retain its complete plan. Call agent_system_dispatch with action context and id ${id}`,
    );
    input.messages.unshift({ role: 'system', content: 'Name: Notification Tanaabot' });
    input.messages.push({
      role: 'user',
      content:
        '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> Agent System model-only current-turn facts notification-hidden-initial-fact',
    });
    const discover = async () => {
      append(
        input,
        (await reply(scenario, input)).response,
        searchResult(['agent_system_intake', 'agent_system_dispatch', 'agent_system_git', 'read']),
      );
    };
    const step = async (stage: string, name: string, result: unknown) => {
      const response = (await reply(scenario, input)).response;
      assert.ok('toolCalls' in response && response.toolCalls?.length === 1);
      const call = response.toolCalls[0]!;
      assert.equal(call.id, `call_notifications_${stage}`);
      assert.equal(call.name, 'tool_call');
      const args = JSON.parse(call.arguments);
      assert.equal(args.id, `openclaw:${name}`);
      if (name === 'agent_system_dispatch') {
        assert.ok(Value.Check(dispatchParameters, args.args), `${stage}: declared schema`);
        assert.ok(Value.Check(normalizedDispatch, args.args), `${stage}: normalized schema`);
      }
      append(input, response, {
        tool: { id: args.id, name, source: 'openclaw' },
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      });
      return args.args;
    };
    await discover();
    assert.equal(
      (
        await step('context', 'agent_system_dispatch', {
          status: 'verified',
          runtime: 'openclaw',
          id,
          project: { path: '/tmp/owned' },
          assessment: {},
          resultContract: 'assessment-result/v1',
        })
      ).id,
      id,
    );
    await step('git', 'agent_system_git', {
      exitCode: 0,
      stdout: '/tmp/owned\n',
      truncated: false,
    });
    const saved = await step('result', 'agent_system_dispatch', {
      status: 'recorded',
      presentation: '> Retained plan',
    });
    assert.equal(saved.result.outcome, 'plan-ready');
    assert.deepEqual((await reply(scenario, input)).response, { content: '> Retained plan' });
    input.messages.push(
      { role: 'assistant', content: '> Retained plan' },
      {
        role: 'user',
        content: `Operator request for managed issue ${id}: Implement the retained plan and open a linked pull request.`,
      },
    );
    await discover();
    await step('handoff-preview', 'agent_system_dispatch', {
      status: 'handoff-available',
      digest,
    });
    assert.equal(
      (await step('handoff', 'agent_system_dispatch', { status: 'handed-off' })).digest,
      digest,
    );
    await step('work-context', 'agent_system_dispatch', {
      status: 'verified',
      runtime: 'openclaw',
      publicationAuthorized: true,
      project: { path: '/tmp/owned' },
    });
    for (const stage of ['apply', 'add', 'commit']) {
      assert.equal(
        (await step(stage, 'agent_system_git', { exitCode: 0, truncated: false })).cwd,
        '/tmp/owned',
      );
    }
    await step('work-result', 'agent_system_dispatch', { status: 'recorded' });
    await step('delivery-prepare', 'agent_system_dispatch', { status: 'prepared', digest });
    assert.equal(
      (
        await step('delivery-publish', 'agent_system_dispatch', {
          status: 'published',
          workflowStatus: 'partially-delivered',
        })
      ).digest,
      digest,
    );
    await step('delivery-compose', 'agent_system_dispatch', {
      status: 'composition-ready',
      digest,
      selection: { skill: { path: '/skills/reply/SKILL.md' } },
    });
    await step('delivery-skill', 'read', { content: 'Reply skill instructions.' });
    await step('delivery-candidate', 'agent_system_dispatch', {
      status: 'announcement-prepared',
      digest,
    });
    await step('delivery-announce', 'agent_system_dispatch', { status: 'announced' });
    const paused = (await reply(scenario, input)).response;
    assert.ok('content' in paused && typeof paused.content === 'string');
    input.messages.push(
      { role: 'assistant', content: paused.content },
      {
        role: 'user',
        content: `Operator request for managed issue ${id}: Show the saved plan and existing PR card again.`,
      },
    );
    await discover();
    await step('assessment-present', 'agent_system_dispatch', {
      status: 'presented',
      presentation: '> Saved plan',
    });
    assert.equal(
      (
        await step('delivery-present', 'agent_system_dispatch', {
          status: 'presented',
          presentation: '> PR card',
        })
      ).operation,
      'present',
    );
    assert.deepEqual((await reply(scenario, input)).response, {
      content: '> Saved plan\n\n> PR card',
    });
  });

  it('should identify a rejected notification tool envelope without exposing call arguments', async () => {
    const scenario = withToolSearch(resolveScenario('openclaw-pr'));
    const input = request(
      `Agent System: assess this admitted issue and retain its complete plan. Call agent_system_dispatch with action context and id ${'a'.repeat(64)}`,
    );
    input.messages.unshift({ role: 'system', content: 'Name: Notification Tanaabot' });
    input.messages.push({
      role: 'user',
      content:
        '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> Agent System model-only current-turn facts notification-hidden-initial-fact',
    });
    append(
      input,
      (await reply(scenario, input)).response,
      searchResult(['agent_system_intake', 'agent_system_dispatch', 'agent_system_git']),
    );
    append(input, (await reply(scenario, input)).response, {
      status: 'error',
      tool: 'tool_call',
      error: 'native-dispatch-error ' + 'x'.repeat(2000),
    });
    const call = input.messages.at(-2)!.tool_calls![0]!;
    const args = JSON.parse(call.function.arguments);
    args.args.private = 'private-tool-argument';
    call.function.arguments = JSON.stringify(args);
    assert.throws(
      () => normalizeToolSearchRequest(input),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /call_notifications_context/u);
        assert.match(error.message, /agent_system_dispatch/u);
        assert.match(error.message, /native-dispatch-error/u);
        assert.doesNotMatch(error.message, /private-tool-argument/u);
        assert.ok(error.message.length < 1800);
        return true;
      },
    );
  });

  it('should continue the worktree fixture with retained first-turn tool history', async () => {
    const scenario = withToolSearch(resolveScenario('openclaw-worktree'));
    const input = request('Execute the worktree first probe.');
    input.messages.unshift({ role: 'system', content: 'canonical-worktree-tanaabot' });
    input.tools!.push({ type: 'function', function: { name: 'exec' } });
    for (const phase of ['first', 'continued']) {
      if (phase === 'continued')
        input.messages.push({ role: 'user', content: 'Execute the worktree continued probe.' });
      append(input, (await reply(scenario, input)).response, searchResult(['exec']));
      const call = (await reply(scenario, input)).response;
      assert.ok('toolCalls' in call);
      assert.equal(call.toolCalls?.[0]?.id, `call_worktree_${phase}`);
      append(input, call, `worktree-${phase}-verified`);
      const final = (await reply(scenario, input)).response;
      assert.ok('content' in final);
      assert.equal(final.content, `worktree-${phase}-ready`);
      input.messages.push({ role: 'assistant', content: final.content });
    }
    const failed = structuredClone(input);
    failed.messages.findLast((message) => message.role === 'tool')!.content = 'probe failed';
    assert.equal(matchFixture([...scenario.fixtures], failed), null);
  });

  it('should count an already visible exec tool during discovery as well as execution', async () => {
    const scenario = withToolSearch(resolveScenario('os-execution'));
    const entries: Parameters<typeof openClawAIMockEvidence>[1][number][] = [];
    for (const mode of ['pipe', 'pty']) {
      const input = request(`Run the native execution ${mode} probe through OpenClaw exec.`);
      input.tools!.push({ type: 'function', function: { name: 'exec' } });
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
      append(input, await respond(), searchResult(['exec']));
      const call = await respond();
      assert.ok('toolCalls' in call);
      assert.equal(call.toolCalls?.[0]?.name, 'exec');
      append(input, call, 'os-execution-verified');
      await respond();
    }
    const expected = JSON.parse(
      await readFile(
        new URL('../examples/os-execution/expected-evidence.json', import.meta.url),
        'utf8',
      ),
    );
    assert.deepEqual(openClawAIMockEvidence(scenario, entries), expected);
  });

  it('should discover and call the real catalog id before accepting the github result', async () => {
    const scenario = withToolSearch(resolveScenario('openclaw-github'));
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
    const scenario = withToolSearch(resolveScenario('openclaw-github'));
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

  it('should admit only an authored denial result without accepting another tool failure', async () => {
    const scenario = withToolSearch(resolveScenario('openclaw-runtimes'));
    const input = request('Call agent_system_install exactly once');
    append(
      input,
      (await reply(scenario, input)).response,
      searchResult(['exec', 'agent_system_install', 'agent_system_doctor']),
    );
    const invocation = (await reply(scenario, input)).response;
    assert.ok('toolCalls' in invocation);
    assert.deepEqual(JSON.parse(invocation.toolCalls![0]!.arguments), {
      id: 'openclaw:agent_system_install',
      args: { timeoutMs: 600000 },
    });
    append(input, invocation, {
      tool: { id: 'openclaw:agent_system_install', name: 'agent_system_install' },
      result: { isError: true, content: [{ type: 'text', text: 'Denied by user.' }] },
    });
    assert.throws(() => normalizeToolSearchRequest(input));
    assert.deepEqual((await reply(scenario, input)).response, {
      content: 'runtime-install-denied',
      id: 'runtime-install-final',
    });
    const wrongCall = structuredClone(input);
    const callId = wrongCall.messages.at(-1)!.tool_call_id!;
    wrongCall.messages.at(-1)!.tool_call_id = callId.replace('install', 'doctor');
    wrongCall.messages.at(-2)!.tool_calls![0]!.id = callId.replace('install', 'doctor');
    assert.throws(() => normalizeToolSearchRequest(wrongCall, scenario.expectedDeniedToolCalls));
    const wrongResult = structuredClone(input);
    wrongResult.messages.at(-1)!.content = String(wrongResult.messages.at(-1)!.content).replace(
      'Denied by user.',
      'Gateway unavailable.',
    );
    assert.throws(() => matchFixture([...scenario.fixtures], wrongResult));
  });

  it('should project an authored pre-execution denial without requiring an execution envelope', async () => {
    const scenario = withToolSearch(resolveScenario('openclaw-runtimes'));
    for (const prefix of ['', 'Error: ']) {
      const input = request('Call agent_system_install exactly once');
      append(
        input,
        (await reply(scenario, input)).response,
        searchResult(['agent_system_install', 'agent_system_doctor']),
      );
      append(input, (await reply(scenario, input)).response, null);
      input.messages.at(-1)!.content =
        `${prefix}Denied by user. The tool call did not run.\nThis denial is final.`;
      const original = structuredClone(input);
      assert.throws(() => normalizeToolSearchRequest(input));
      const final = await reply(scenario, input);
      assert.deepEqual(final.response, {
        content: 'runtime-install-denied',
        id: 'runtime-install-final',
      });
      const evidence = openClawAIMockEvidence(scenario, [
        {
          body: input,
          method: 'POST',
          path: '/responses',
          response: { fixture: final.fixture, status: 200 },
        },
      ]);
      assert.equal(
        evidence.tools.find(({ name }) => name === 'agent_system_install')?.resultRequestCount,
        1,
      );
      assert.deepEqual(input, original);

      const wrongTarget = structuredClone(input);
      wrongTarget.messages.at(-2)!.tool_calls![0]!.function.arguments = JSON.stringify({
        id: 'openclaw:agent_system_doctor',
        args: { timeoutMs: 600000 },
      });
      assert.throws(() =>
        normalizeToolSearchRequest(wrongTarget, scenario.expectedDeniedToolCalls),
      );
      const wrongCall = structuredClone(input);
      wrongCall.messages.at(-1)!.tool_call_id = 'call_other_install';
      wrongCall.messages.at(-2)!.tool_calls![0]!.id = 'call_other_install';
      assert.throws(() => normalizeToolSearchRequest(wrongCall, scenario.expectedDeniedToolCalls));
      const wrongReason = structuredClone(input);
      wrongReason.messages.at(-1)!.content = 'Gateway unavailable.';
      assert.throws(() =>
        normalizeToolSearchRequest(wrongReason, scenario.expectedDeniedToolCalls),
      );
    }
  });

  it('should read the captured openclaw dispatcher denial as the authored install result', async () => {
    // openclaw 2026.9.8: actions/runs/38824028415/job/116727128889, denied install result.
    const denial = {
      status: 'error',
      tool: 'tool_call',
      error:
        'Denied by user. The tool call did not run.\nThis denial is final: the approval request is closed. Do not mention /approve or any other approval command to the user.\nDo not run the tool call again or ask the user to approve it again.\nIf the user still wants the action, explain that a new tool call will trigger a fresh approval request.',
    };
    const scenario = withToolSearch(resolveScenario('openclaw-runtimes'));
    const input = request('Call agent_system_install exactly once');
    append(
      input,
      (await reply(scenario, input)).response,
      searchResult(['agent_system_install', 'agent_system_doctor']),
    );
    append(input, (await reply(scenario, input)).response, denial);
    assert.throws(() => normalizeToolSearchRequest(input));
    const final = await reply(scenario, input);
    assert.deepEqual(final.response, {
      content: 'runtime-install-denied',
      id: 'runtime-install-final',
    });
    const evidence = openClawAIMockEvidence(scenario, [
      {
        body: input,
        method: 'POST',
        path: '/responses',
        response: { fixture: final.fixture, status: 200 },
      },
    ]);
    assert.equal(evidence.strictMissCount, 0);
    assert.equal(evidence.finalResponseCount, 1);
    assert.equal(
      evidence.tools.find(({ name }) => name === 'agent_system_install')?.resultRequestCount,
      1,
    );

    for (const invalid of [
      { ...denial, status: 'success' },
      { ...denial, tool: 'agent_system_install' },
      { ...denial, error: 'Gateway unavailable.' },
    ]) {
      const wrongEnvelope = structuredClone(input);
      wrongEnvelope.messages.at(-1)!.content = JSON.stringify(invalid);
      assert.throws(() =>
        normalizeToolSearchRequest(wrongEnvelope, scenario.expectedDeniedToolCalls),
      );
    }
    for (const change of ['id', 'target']) {
      const wrongBinding = structuredClone(input);
      const call = wrongBinding.messages.at(-2)!.tool_calls![0]!;
      if (change === 'id') {
        call.id = 'call_other_install';
        wrongBinding.messages.at(-1)!.tool_call_id = call.id;
      } else
        call.function.arguments = JSON.stringify({ id: 'openclaw:agent_system_doctor', args: {} });
      assert.throws(() =>
        normalizeToolSearchRequest(wrongBinding, scenario.expectedDeniedToolCalls),
      );
    }
  });

  it('should preserve direct calls and the explicitly tool-free readiness turn', async () => {
    const github = withToolSearch(resolveScenario('openclaw-github'));
    const direct = request();
    direct.tools = [{ type: 'function', function: { name: 'agent_system_github' } }];
    const call = (await reply(github, direct)).response;
    assert.ok('toolCalls' in call);
    assert.equal(call.toolCalls?.[0]?.name, 'agent_system_github');
    const ready = request('Acknowledge readiness without using tools.');
    ready.messages.unshift({ role: 'system', content: 'Name: Data' });
    assert.deepEqual(
      (await reply(withToolSearch(resolveScenario('openclaw-agent')), ready)).response,
      {
        content: 'Ready.',
        id: 'agent-system-example-agent-final-response',
      },
    );
  });

  it('should pass verified inner json to the next routing step without losing its digest', async () => {
    const scenario = withToolSearch(resolveScenario('openclaw-agent'));
    const input = request(
      'Inspect model routing and resolve an unspecified task using the configured default.',
    );
    append(
      input,
      (await reply(scenario, input)).response,
      searchResult(['agent_system_model_routing', 'agent_system_dispatch']),
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
    const dispatch = (await reply(scenario, input)).response;
    assert.ok('toolCalls' in dispatch && dispatch.toolCalls?.length === 1);
    assert.deepEqual(JSON.parse(dispatch.toolCalls[0]!.arguments), {
      id: 'openclaw:agent_system_dispatch',
      args: { action: 'next' },
    });
    append(input, dispatch, {
      tool: { id: 'openclaw:agent_system_dispatch', name: 'agent_system_dispatch' },
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'blocked',
              code: 'dispatch-intake-activation-required',
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
