import assert from 'node:assert/strict';

import githubNotificationModelEvidence from '../scripts/github-notification-model-evidence.ts';
import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from '../scripts/github-notification-model-scenarios.ts';

const scenario = resolveGitHubNotificationModelScenario('assignment-provider-proof');

describe('scripts/github-notification-model-evidence', () => {
  it('should normalize one strict tool loop across accepted responses paths', () => {
    for (const scenarioId of githubNotificationModelScenarioIds) {
      const selectedScenario = resolveGitHubNotificationModelScenario(scenarioId);
      const selectedPrompt = selectedScenario.promptSignals.join('\n');
      const callId = selectedScenario.toolCalls[0]?.id ?? '';
      const finalResponse = selectedScenario.finalResponses[0] ?? '';
      const evidence = githubNotificationModelEvidence(selectedScenario, [
        {
          body: {
            messages: [{ content: selectedPrompt, role: 'system' }],
            model: 'gpt-5.5',
            tools: [
              { function: { name: 'agent_system_github_reply' } },
              { function: { name: 'read' } },
            ],
          },
          method: 'POST',
          path: '/responses',
          response: {
            fixture: {
              response: {
                toolCalls: [{ id: callId, name: 'agent_system_github_reply' }],
              },
            },
            status: 200,
          },
        },
        {
          body: {
            messages: [
              { content: selectedPrompt, role: 'system' },
              {
                content: '{"status":"staged"}',
                role: 'tool',
                tool_call_id: callId,
              },
            ],
            model: 'gpt-5.5',
            tools: [{ function: { name: 'agent_system_github_reply' } }],
          },
          method: 'POST',
          path: '/v1/responses',
          response: {
            fixture: { response: { content: finalResponse } },
            status: 200,
          },
        },
      ]);

      assert.deepEqual(evidence, {
        finalResponseCount: 1,
        model: 'aimock/gpt-5.5',
        promptRequestCount: 2,
        provider: 'aimock',
        requestCount: 2,
        responsesApiRequestCount: 2,
        scenario: scenarioId,
        schemaVersion: 2,
        strictMissCount: 0,
        successfulFixtureResponseCount: 2,
        tools: [
          {
            callResponseCount: 1,
            name: 'agent_system_github_reply',
            projectionRequestCount: 2,
            resultRequestCount: 1,
          },
        ],
      });
    }
  });

  it('should report unmatched requests without inventing successful evidence', () => {
    const evidence = githubNotificationModelEvidence(scenario, [
      {
        body: { messages: [], model: 'unexpected-model', tools: [] },
        method: 'POST',
        path: '/responses',
        response: { fixture: null, status: 503 },
      },
    ]);

    assert.deepEqual(evidence, {
      finalResponseCount: 0,
      model: 'unexpected-model',
      promptRequestCount: 0,
      provider: 'aimock',
      requestCount: 1,
      responsesApiRequestCount: 1,
      scenario: 'assignment-provider-proof',
      schemaVersion: 2,
      strictMissCount: 1,
      successfulFixtureResponseCount: 0,
      tools: [
        {
          callResponseCount: 0,
          name: 'agent_system_github_reply',
          projectionRequestCount: 0,
          resultRequestCount: 0,
        },
      ],
    });
  });
});
