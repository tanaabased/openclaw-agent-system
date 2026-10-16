import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock } from 'node:test';

import { matchFixture, type ChatCompletionRequest, type ContentPart } from '@copilotkit/aimock';

import { credentialExampleChecks } from '../examples/credentials/model-fixture.ts';
import {
  githubExampleEmoriCallId,
  githubExampleEmoriPrompt,
  githubExampleTanaabotCallId,
  githubExampleTanaabotPrompt,
} from '../examples/github/model-fixture.ts';
import resolveExampleModelScenario, {
  exampleModelScenarioIds,
} from '../scripts/example-model-scenarios.ts';
import resolveOpenClawAIMockScenario from '../scripts/aimock-scenarios.ts';

function request(
  agentId: string,
  message: string,
  tools: string[],
  toolResult?: { callId: string; content: string | ContentPart[] },
): ChatCompletionRequest {
  return {
    messages: [
      {
        content: [`Agent ID: \`${agentId}\``, ...(agentId === 'data' ? ['Name: Data'] : [])].join(
          '\n',
        ),
        role: 'system',
      },
      { content: message, role: 'user' },
      ...(toolResult === undefined
        ? []
        : [
            {
              content: null,
              role: 'assistant' as const,
              tool_calls: [
                {
                  function: { arguments: '{}', name: tools[0] ?? '' },
                  id: toolResult.callId,
                  type: 'function' as const,
                },
              ],
            },
            {
              content: toolResult.content,
              role: 'tool' as const,
              tool_call_id: toolResult.callId,
            },
          ]),
    ],
    model: 'gpt-5.5',
    tools: tools.map((name) => ({ function: { name }, type: 'function' })),
  };
}

describe('scripts/example-model-scenarios', () => {
  it('should resolve the deterministic example scenarios', () => {
    assert.deepEqual(exampleModelScenarioIds, [
      'openclaw-agent',
      'collaboration',
      'openclaw-collaboration',
      'openclaw-automations',
      'credentials',
      'openclaw-credentials',
      'github',
      'os-execution',
      'openclaw-runtimes',
    ]);
    assert.equal(resolveOpenClawAIMockScenario('openclaw-agent').id, 'openclaw-agent');
    assert.equal(resolveOpenClawAIMockScenario('credentials').id, 'credentials');
    assert.equal(resolveOpenClawAIMockScenario('github').id, 'github');
    assert.throws(
      () => resolveExampleModelScenario('unsupported'),
      /Unsupported example model scenario: unsupported/u,
    );
  });

  it('should acknowledge agent readiness without a tool call', () => {
    const scenario = resolveExampleModelScenario('openclaw-agent');
    const fixture = matchFixture(
      [...scenario.fixtures],
      request('data', 'Acknowledge readiness without using tools.', []),
    );

    assert.equal(fixture, scenario.fixtures[0]);
    assert.deepEqual(fixture?.response, {
      content: 'Ready.',
      id: 'agent-system-example-agent-final-response',
    });
  });

  it('should complete native runtime fixtures only after their own execution or doctor result', () => {
    const scenario = resolveExampleModelScenario('openclaw-runtimes');
    for (const [tool, prompt, callId, validResult, invalidResult, expected] of [
      [
        'exec',
        'Run agent-system-runtime-probe openclaw',
        'call_runtime_exec',
        'runtime-boundary-verified',
        'command failed',
        'runtime-exec-ready',
      ],
      [
        'agent_system_doctor',
        'Call agent_system_doctor exactly once',
        'call_runtime_doctor',
        '{"findings":[]}',
        '{"status":"error"}',
        'runtime-doctor-ready',
      ],
    ] as const) {
      const input = request('runtime-openclaw', prompt, [tool]);
      const fixture = matchFixture([...scenario.fixtures], input);
      assert.ok(fixture);
      const response = fixture.response;
      assert.ok(typeof response !== 'function' && 'toolCalls' in response);
      assert.equal(response.toolCalls?.[0]?.name, tool);
      if (tool === 'exec') {
        assert.equal(
          JSON.parse(response.toolCalls![0]!.arguments).command,
          'agent-system-runtime-probe openclaw',
        );
      }
      for (const [observedId, content] of [
        ['unrelated', validResult],
        [callId, invalidResult],
      ]) {
        assert.equal(
          matchFixture(
            [...scenario.fixtures],
            request('runtime-openclaw', prompt, [tool], { callId: observedId!, content: content! }),
          ),
          null,
        );
      }
      const final = matchFixture(
        [...scenario.fixtures],
        request('runtime-openclaw', prompt, [tool], { callId, content: validResult }),
      )?.response;
      assert.ok(final && typeof final !== 'function' && 'content' in final);
      assert.equal(final.content, expected);
    }
  });

  it('should require the matching native execution receipt before completing either shell mode', () => {
    const scenario = resolveExampleModelScenario('os-execution');
    for (const mode of ['pipe', 'pty']) {
      const prompt = `Run the native execution ${mode} probe through OpenClaw exec.`;
      const callId = `call_os_execution_${mode}`;
      const input = request('os-execution', prompt, ['exec']);
      const invocation = matchFixture([...scenario.fixtures], input)?.response;
      assert.ok(invocation && typeof invocation !== 'function' && 'toolCalls' in invocation);
      const call = invocation.toolCalls?.[0];
      assert.equal(call?.name, 'exec');
      assert.equal(JSON.parse(call!.arguments).pty, mode === 'pty');
      assert.equal(JSON.parse(call!.arguments).command, `sh ./probe.sh ${mode}`);
      for (const [observedCall, content, success] of [
        [callId, 'os-execution-verified', true],
        [callId, 'code=agent_not_resolved', false],
        ['call_unrelated', 'os-execution-verified', false],
      ] as const) {
        const result = matchFixture(
          [...scenario.fixtures],
          request('os-execution', prompt, ['exec'], { callId: observedCall, content }),
        );
        assert.equal(result !== null, success);
      }
    }
  });

  it('should match collaboration requests against the scenario workspace identities', async () => {
    const scenario = resolveExampleModelScenario('collaboration');
    for (const [agentId, prompt, fixtureIndex] of [
      ['beta', 'collaboration-ready', 0],
      ['beta', 'collaboration-ping', 1],
      ['alpha', 'collaboration-send', 2],
    ] as const) {
      const input = request(agentId, prompt, ['sessions_send']);
      input.messages[0]!.content = await readFile(
        new URL(`../examples/collaboration/${agentId}/IDENTITY.md`, import.meta.url),
        'utf8',
      );
      assert.equal(matchFixture([...scenario.fixtures], input), scenario.fixtures[fixtureIndex]);
      input.messages.push({
        role: 'user',
        content:
          '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nRuntime facts.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
      });
      assert.equal(matchFixture([...scenario.fixtures], input), scenario.fixtures[fixtureIndex]);
      input.messages[0]!.content = 'Name: Someone Else';
      assert.equal(matchFixture([...scenario.fixtures], input), null);
    }
  });

  it('should match the current collaboration turn without replaying readiness from history', () => {
    const scenario = resolveExampleModelScenario('collaboration');
    const input = request('beta', 'collaboration-ready', []);
    input.messages[0]!.content = 'Name: Beta';
    input.messages.push(
      { role: 'assistant', content: 'collaboration-ready' },
      { role: 'user', content: 'collaboration-ping' },
      {
        role: 'user',
        content:
          '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nRuntime facts.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
      },
    );
    assert.deepEqual(matchFixture([...scenario.fixtures], input)?.response, {
      content: 'collaboration-pong',
    });
    input.messages.push({ role: 'user', content: 'An unrelated request.' });
    assert.equal(matchFixture([...scenario.fixtures], input), null);
  });

  it('should accept collaboration completion only after a successful peer reply', () => {
    const scenario = resolveExampleModelScenario('collaboration');
    const result = (status: string, reply: string) =>
      request('alpha', 'collaboration-send', ['sessions_send'], {
        callId: 'call_collaboration_send',
        content: JSON.stringify({ status, reply }),
      });
    const success = matchFixture([...scenario.fixtures], result('ok', 'collaboration-pong'));
    assert.deepEqual(success?.response, { content: 'collaboration-exchange-complete' });
    assert.equal(
      matchFixture([...scenario.fixtures], result('forbidden', 'collaboration-pong')),
      null,
    );
    assert.equal(matchFixture([...scenario.fixtures], result('ok', 'wrong peer')), null);
  });

  it('should match the focused collaboration turns only for their workspace identities', async () => {
    const scenario = resolveExampleModelScenario('openclaw-collaboration');
    for (const [agentId, prompt, tool, fixtureIndex] of [
      ['beta', 'collaboration-ready', '', 0],
      ['beta', 'collaboration-ping', '', 1],
      ['alpha', 'collaboration-send', 'sessions_send', 2],
      ['alpha', 'collaboration-read', 'sessions_history', 4],
    ] as const) {
      const input = request(agentId, prompt, tool ? [tool] : []);
      input.messages[0]!.content = await readFile(
        new URL(`../examples/openclaw-collaboration/${agentId}/IDENTITY.md`, import.meta.url),
        'utf8',
      );
      assert.equal(matchFixture([...scenario.fixtures], input), scenario.fixtures[fixtureIndex]);
      input.messages[0]!.content = 'Name: External';
      assert.equal(matchFixture([...scenario.fixtures], input), null);
    }
  });

  it('should complete the focused collaboration exchange only for its successful peer result', () => {
    const scenario = resolveExampleModelScenario('openclaw-collaboration');
    const input = (callId: string, content: string) => {
      const value = request('alpha', 'collaboration-send', ['sessions_send'], { callId, content });
      value.messages[0]!.content = 'Name: Alpha';
      return value;
    };
    const reply = JSON.stringify({ status: 'ok', reply: 'collaboration-pong' });
    assert.deepEqual(
      matchFixture([...scenario.fixtures], input('call_collaboration_send', reply))?.response,
      { content: 'collaboration-exchange-complete' },
    );
    for (const [callId, content] of [
      ['another-call', reply],
      ['call_collaboration_send', '{"status":"forbidden","reply":"collaboration-pong"}'],
      ['call_collaboration_send', '{"status":"ok","reply":"wrong peer"}'],
      ['call_collaboration_send', 'not json'],
    ]) {
      assert.equal(matchFixture([...scenario.fixtures], input(callId!, content!)), null);
    }
    const stale = input('call_collaboration_send', reply);
    stale.messages.push({ role: 'user', content: 'An unrelated request.' });
    assert.equal(matchFixture([...scenario.fixtures], stale), null);
  });

  it('should verify focused collaboration history only for the requested peer transcript', () => {
    const scenario = resolveExampleModelScenario('openclaw-collaboration');
    const history = {
      sessionKey: 'agent:beta:collaboration',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'collaboration-pong' }] }],
    };
    const input = (value: unknown, callId = 'call_collaboration_history') => {
      const valueRequest = request('alpha', 'collaboration-read', ['sessions_history'], {
        callId,
        content: JSON.stringify(value),
      });
      valueRequest.messages[0]!.content = 'Name: Alpha';
      return valueRequest;
    };
    assert.deepEqual(matchFixture([...scenario.fixtures], input(history))?.response, {
      content: 'collaboration-history-verified',
    });
    for (const value of [
      { status: 'forbidden' },
      { ...history, sessionKey: 'agent:external:collaboration' },
      { ...history, messages: [{ role: 'user', content: 'collaboration-pong' }] },
      { ...history, messages: [{ role: 'assistant', content: 'collaboration-ready' }] },
      { ...history, messages: [null] },
    ]) {
      assert.equal(matchFixture([...scenario.fixtures], input(value)), null);
    }
    assert.equal(matchFixture([...scenario.fixtures], input(history, 'another-call')), null);
  });

  it('should keep automation ownership strict and report only failed match booleans', () => {
    const scenario = resolveExampleModelScenario('openclaw-automations');
    const diagnostic = mock.method(console, 'error', () => {});
    const valid = request('automation-tanaabot', scenario.userPromptSignals![0]!, []);
    valid.messages[0]!.content = scenario.systemPromptSignals[0]!;
    valid.messages.push({ role: 'user', content: 'Additional runtime context.' });
    try {
      assert.equal(matchFixture([...scenario.fixtures], valid), scenario.fixtures[0]);
      assert.equal(diagnostic.mock.callCount(), 0);
      for (const field of ['model', 'identity', 'prompt', 'noToolResult'] as const) {
        const invalid = structuredClone(valid);
        if (field === 'model') invalid.model = 'private-model';
        if (field === 'identity') invalid.messages[0]!.content = 'private-identity';
        if (field === 'prompt') {
          invalid.messages[1]!.content = 'private-prompt';
          invalid.messages.push({ role: 'assistant', content: scenario.userPromptSignals![0]! });
        }
        if (field === 'noToolResult') {
          invalid.messages.push({ role: 'tool', content: 'private-result', tool_call_id: 'call' });
        }
        assert.equal(matchFixture([...scenario.fixtures], invalid), null);
        const output = String(diagnostic.mock.calls.at(-1)!.arguments[0]);
        assert.deepEqual(JSON.parse(output.slice(output.indexOf('{'))), {
          model: field !== 'model',
          identity: field !== 'identity',
          prompt: field !== 'prompt',
          noToolResult: field !== 'noToolResult',
        });
        assert.ok(!output.includes('private-'));
      }
    } finally {
      diagnostic.mock.restore();
    }
  });

  it('should return each login only after validating the real tool result', () => {
    const scenario = resolveExampleModelScenario('github');
    const cases = [
      {
        agentId: 'tanaabot',
        callId: githubExampleTanaabotCallId,
        expectedLogin: 'tanaabot',
        message: githubExampleTanaabotPrompt,
        tool: 'agent_system_github',
      },
      {
        agentId: 'emori',
        callId: githubExampleEmoriCallId,
        expectedLogin: 'emoriwan',
        message: githubExampleEmoriPrompt,
        tool: 'agent_system_github',
      },
    ] as const;

    for (const entry of cases) {
      const initialRequest = request(entry.agentId, entry.message, [entry.tool]);
      const initialFixture = matchFixture([...scenario.fixtures], initialRequest);
      assert.equal(typeof initialFixture?.response, 'object');
      assert.deepEqual(
        'toolCalls' in (initialFixture?.response ?? {})
          ? (initialFixture?.response as { toolCalls: unknown[] }).toolCalls
          : [],
        [
          {
            arguments: JSON.stringify({ argv: ['api', 'user', '--jq', '.login'] }),
            id: entry.callId,
            name: entry.tool,
          },
        ],
      );

      assert.equal(
        matchFixture(
          [...scenario.fixtures],
          request(entry.agentId, entry.message, [entry.tool], {
            callId: entry.callId,
            content: 'unexpected-login',
          }),
        ),
        null,
      );
      const finalFixture = matchFixture(
        [...scenario.fixtures],
        request(entry.agentId, entry.message, [entry.tool], {
          callId: entry.callId,
          content: JSON.stringify({ login: entry.expectedLogin }),
        }),
      );
      assert.deepEqual(finalFixture?.response, {
        content: entry.expectedLogin,
        id: `${entry.callId}_final_response`,
      });
    }
  });

  it('should complete each cache turn only after a successful local git tool result', () => {
    for (const scenarioId of ['credentials', 'openclaw-credentials']) {
      const scenario = resolveExampleModelScenario(scenarioId);
      for (const { agentId, callId, prompt } of credentialExampleChecks) {
        const initial = matchFixture(
          [...scenario.fixtures],
          request(agentId, prompt, ['agent_system_git']),
        );
        assert.deepEqual(initial?.response, {
          id: `${callId}_tool_response`,
          toolCalls: [
            {
              arguments: JSON.stringify({ argv: ['--version'] }),
              id: callId,
              name: 'agent_system_git',
            },
          ],
        });
        assert.equal(
          matchFixture(
            [...scenario.fixtures],
            request(agentId, prompt, ['agent_system_git'], {
              callId,
              content: 'credential unavailable',
            }),
          ),
          null,
        );
        const final = matchFixture(
          [...scenario.fixtures],
          request(agentId, prompt, ['agent_system_git'], { callId, content: 'git version 2.50.0' }),
        );
        assert.deepEqual(final?.response, { content: 'git ready', id: `${callId}_final_response` });
      }
    }
  });
});
