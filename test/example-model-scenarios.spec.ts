import assert from 'node:assert/strict';
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
    assert.deepEqual(exampleModelScenarioIds, ['agent', 'automations', 'credentials', 'github']);
    assert.equal(resolveOpenClawAIMockScenario('agent').id, 'agent');
    assert.equal(resolveOpenClawAIMockScenario('credentials').id, 'credentials');
    assert.equal(resolveOpenClawAIMockScenario('github').id, 'github');
    assert.throws(
      () => resolveExampleModelScenario('unsupported'),
      /Unsupported example model scenario: unsupported/u,
    );
  });

  it('should acknowledge agent readiness without a tool call', () => {
    const scenario = resolveExampleModelScenario('agent');
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

  it('should keep automation ownership strict and report only failed match booleans', () => {
    const scenario = resolveExampleModelScenario('automations');
    const diagnostic = mock.method(console, 'error', () => {});
    const valid = request('automation-tanaabot', scenario.userPromptSignals![0]!, []);
    valid.messages[0]!.content = scenario.systemPromptSignals[0]!;
    try {
      assert.equal(matchFixture([...scenario.fixtures], valid), scenario.fixtures[0]);
      assert.equal(diagnostic.mock.callCount(), 0);
      for (const field of ['model', 'identity', 'prompt', 'noToolResult'] as const) {
        const invalid = structuredClone(valid);
        if (field === 'model') invalid.model = 'private-model';
        if (field === 'identity') invalid.messages[0]!.content = 'private-identity';
        if (field === 'prompt') invalid.messages[1]!.content = 'private-prompt';
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
    const scenario = resolveExampleModelScenario('credentials');
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
  });
});
