import assert from 'node:assert/strict';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';

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
  toolResult?: { callId: string; content: string },
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
    assert.deepEqual(exampleModelScenarioIds, ['agent', 'credentials', 'github']);
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

  it('should acknowledge a synthetic quota turn only after safe provider evidence reaches its native tool result', () => {
    const scenario = resolveExampleModelScenario('credentials');
    const prompt =
      'Use the configured Git tool to report its version for the synthetic provider diagnostic check.';
    const callId = 'call_example_quota_diagnostic';
    const safe =
      'provider="1password" classification="rate-limit" httpStatus="unknown" resetAt="unknown"';
    for (const content of [
      'credential unavailable',
      safe.replace('1password', 'github'),
      `${safe} SYNTHETIC_PRIVATE_TOKEN`,
      `${safe} op://synthetic/item/credential`,
    ]) {
      assert.equal(
        matchFixture(
          [...scenario.fixtures],
          request('quota-diagnostic', prompt, ['agent_system_git'], { callId, content }),
        ),
        null,
      );
    }
    assert.deepEqual(
      matchFixture(
        [...scenario.fixtures],
        request('quota-diagnostic', prompt, ['agent_system_git'], { callId, content: safe }),
      )?.response,
      { id: 'quota_final_response', content: 'quota reported' },
    );
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
