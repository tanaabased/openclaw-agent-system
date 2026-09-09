import assert from 'node:assert/strict';

import { matchFixture, type ChatCompletionRequest } from '@copilotkit/aimock';

import {
  githubExampleEmoriCallId,
  githubExampleTanaabotCallId,
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
  it('should resolve the two deterministic example scenarios', () => {
    assert.deepEqual(exampleModelScenarioIds, ['agent', 'github']);
    assert.equal(resolveOpenClawAIMockScenario('agent').id, 'agent');
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
        message: 'Use the preferred configured GitHub integration to identify the account.',
        tool: 'agent_system_github',
      },
      {
        agentId: 'emori',
        callId: githubExampleEmoriCallId,
        expectedLogin: 'emoriwan',
        message: 'Use the preferred configured GitHub integration to identify the account.',
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
});
