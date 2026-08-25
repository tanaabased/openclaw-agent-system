import assert from 'node:assert/strict';

import githubNotificationModelEvidence from '../scripts/github-notification-model-evidence.ts';
import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from '../scripts/github-notification-model-scenarios.ts';

const scenario = resolveGitHubNotificationModelScenario('assignment');

describe('scripts/github-notification-model-evidence', () => {
  it('should normalize one strict tool loop across accepted responses paths', () => {
    for (const scenarioId of githubNotificationModelScenarioIds.filter(
      (id) => !['implementation', 'pr', 'comment', 'retirement'].includes(id),
    )) {
      const selectedScenario = resolveGitHubNotificationModelScenario(scenarioId);
      const selectedPromptMessages = [
        {
          content: selectedScenario.systemPromptSignals.join('\n'),
          role: 'system' as const,
        },
        ...(selectedScenario.userPromptSignals === undefined
          ? []
          : [
              {
                content: selectedScenario.userPromptSignals.join('\n'),
                role: 'user' as const,
              },
            ]),
      ];
      const callId = selectedScenario.toolCalls[0]?.id ?? '';
      const finalResponse = selectedScenario.finalResponses[0] ?? '';
      const evidence = githubNotificationModelEvidence(selectedScenario, [
        {
          body: {
            messages: structuredClone(selectedPromptMessages),
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
              ...structuredClone(selectedPromptMessages),
              {
                content: null,
                role: 'assistant',
                tool_calls: [
                  {
                    function: { name: 'agent_system_github_reply' },
                    id: callId,
                  },
                ],
              },
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

  it('should normalize execution tool loops, including repeated retirement assignments', () => {
    for (const scenarioId of ['implementation', 'pr', 'comment', 'retirement']) {
      const selectedScenario = resolveGitHubNotificationModelScenario(scenarioId);
      const prompt = selectedScenario.systemPromptSignals.join('\n');
      const [reply, issue, patch, add, commit, commentReply] = selectedScenario.toolCalls;
      const toolNames = [
        'agent_system_github_reply',
        'agent_system_github',
        'apply_patch',
        'agent_system_git',
      ];
      type EvidenceEntry = Parameters<typeof githubNotificationModelEvidence>[1][number];
      const messages: NonNullable<EvidenceEntry['body']>['messages'] = [
        { content: prompt, role: 'system' },
      ];
      const entries: EvidenceEntry[] = [];
      const request = (response: Record<string, unknown>): EvidenceEntry => ({
        body: {
          messages: structuredClone(messages),
          model: 'gpt-5.5',
          tools: toolNames.map((name) => ({ function: { name } })),
        },
        method: 'POST',
        path: '/v1/responses',
        response: { fixture: { response }, status: 200 },
      });
      const appendCall = (call: (typeof selectedScenario.toolCalls)[number]): void => {
        messages?.push(
          {
            content: null,
            role: 'assistant',
            tool_calls: [{ function: { name: call.name }, id: call.id }],
          },
          { content: '{"status":"completed"}', role: 'tool', tool_call_id: call.id },
        );
      };
      if (
        !reply ||
        !issue ||
        !patch ||
        !add ||
        !commit ||
        !messages ||
        (scenarioId === 'comment' && !commentReply)
      ) {
        throw new Error(`The ${scenarioId} scenario tool contract is incomplete.`);
      }

      entries.push(request({}));
      appendCall(reply);
      entries.push(request({ content: selectedScenario.finalResponses[0] }));
      if (scenarioId === 'retirement') {
        messages.splice(0, messages.length, { content: prompt, role: 'system' });
        entries.push(request({}));
        appendCall(reply);
        entries.push(request({ content: selectedScenario.finalResponses[0] }));
      }
      messages.splice(0, messages.length, { content: prompt, role: 'system' });
      entries.push(request({}));
      appendCall(issue);
      entries.push(request({}));
      appendCall(patch);
      entries.push(request({}));
      appendCall(add);
      entries.push(request({}));
      appendCall(commit);
      entries.push(request({ content: selectedScenario.finalResponses[1] }));
      if (scenarioId === 'comment' && commentReply) {
        messages.splice(0, messages.length, { content: prompt, role: 'system' });
        entries.push(request({}));
        appendCall(commentReply);
        entries.push(request({ content: selectedScenario.finalResponses[2] }));
      }

      const hasThirdResponse = scenarioId === 'comment' || scenarioId === 'retirement';
      const requestCount = hasThirdResponse ? 9 : 7;

      assert.deepEqual(githubNotificationModelEvidence(selectedScenario, entries), {
        finalResponseCount: hasThirdResponse ? 3 : 2,
        model: 'aimock/gpt-5.5',
        promptRequestCount: requestCount,
        provider: 'aimock',
        requestCount,
        responsesApiRequestCount: requestCount,
        scenario: scenarioId,
        schemaVersion: 2,
        strictMissCount: 0,
        successfulFixtureResponseCount: requestCount,
        tools: [
          {
            callResponseCount: 2,
            name: 'agent_system_git',
            projectionRequestCount: requestCount,
            resultRequestCount: 3,
          },
          {
            callResponseCount: 1,
            name: 'agent_system_github',
            projectionRequestCount: requestCount,
            resultRequestCount: 4,
          },
          {
            callResponseCount: scenarioId === 'comment' ? 2 : 1,
            name: 'agent_system_github_reply',
            projectionRequestCount: requestCount,
            resultRequestCount: hasThirdResponse ? 2 : 1,
          },
          {
            callResponseCount: 1,
            name: 'apply_patch',
            projectionRequestCount: requestCount,
            resultRequestCount: 3,
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
      scenario: 'assignment',
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
