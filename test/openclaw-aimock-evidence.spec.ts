import assert from 'node:assert/strict';

import { githubNotificationAssignmentGroupsCallId } from '../scenarios/issue-work-assignment/model-fixture.ts';
import openClawAIMockEvidence from '../scripts/aimock-evidence.ts';
import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from '../scripts/github-notification-model-scenarios.ts';

const scenario = resolveGitHubNotificationModelScenario('assignment');

describe('scripts/aimock-evidence', () => {
  it('should normalize one strict tool loop across accepted responses paths', () => {
    for (const scenarioId of githubNotificationModelScenarioIds.filter(
      (id) => id === 'assignment',
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
      const observedCalls = selectedScenario.toolCalls.map((call) => ({
        function: { name: call.name },
        id: `${call.id}_fc-observed_123`,
      }));
      const finalResponse = selectedScenario.finalResponses[0] ?? '';
      const groupCalls = selectedScenario.toolCalls.filter(
        (call) => call.id === githubNotificationAssignmentGroupsCallId,
      );
      const observedGroupCalls = observedCalls.filter((call) =>
        call.id.startsWith(githubNotificationAssignmentGroupsCallId),
      );
      const evidence = openClawAIMockEvidence(selectedScenario, [
        {
          body: {
            messages: structuredClone(selectedPromptMessages),
            model: 'gpt-5.5',
            tools: [
              { function: { name: 'agent_system_github_reply' } },
              { function: { name: 'read' } },
              { function: { name: 'sessions' } },
            ],
          },
          method: 'POST',
          path: '/responses',
          response: {
            fixture: {
              response: {
                toolCalls: groupCalls,
              },
            },
            status: 200,
          },
        },
        {
          body: {
            messages: [
              ...structuredClone(selectedPromptMessages),
              { content: null, role: 'assistant', tool_calls: observedGroupCalls },
              ...observedGroupCalls.map((call) => ({
                content: '{"groups":[{"name":"Active Work","position":0}],"sectionOrder":[]}',
                role: 'tool',
                tool_call_id: call.id,
              })),
            ],
            model: 'gpt-5.5',
            tools: [
              { function: { name: 'agent_system_github_reply' } },
              { function: { name: 'sessions' } },
            ],
          },
          method: 'POST',
          path: '/responses',
          response: {
            fixture: {
              response: {
                toolCalls: selectedScenario.toolCalls.filter(
                  (call) => call.id !== githubNotificationAssignmentGroupsCallId,
                ),
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
                tool_calls: observedCalls,
              },
              ...observedCalls.map((call) => ({
                content: '{"status":"updated"}',
                role: 'tool',
                tool_call_id: call.id,
              })),
            ],
            model: 'gpt-5.5',
            tools: [
              { function: { name: 'agent_system_github_reply' } },
              { function: { name: 'sessions' } },
            ],
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
        promptRequestCount: 3,
        provider: 'aimock',
        requestCount: 3,
        responsesApiRequestCount: 3,
        scenario: scenarioId,
        schemaVersion: 2,
        strictMissCount: 0,
        successfulFixtureResponseCount: 3,
        tools: [
          {
            callResponseCount: 1,
            name: 'agent_system_github_reply',
            projectionRequestCount: 3,
            resultRequestCount: 1,
          },
          {
            callResponseCount: 3,
            name: 'sessions',
            projectionRequestCount: 3,
            resultRequestCount: 4,
          },
        ],
      });
    }
  });

  it('should normalize one guided assignment without a public reply tool call', () => {
    const selectedScenario = resolveGitHubNotificationModelScenario('guided-assignment');
    const promptMessages = [
      { content: selectedScenario.systemPromptSignals.join('\n'), role: 'system' as const },
      {
        content: selectedScenario.userPromptSignals?.join('\n') ?? '',
        role: 'user' as const,
      },
    ];

    assert.deepEqual(
      openClawAIMockEvidence(selectedScenario, [
        {
          body: {
            messages: promptMessages,
            model: 'gpt-5.5',
            tools: [{ function: { name: 'agent_system_github_reply' } }],
          },
          method: 'POST',
          path: '/responses',
          response: {
            fixture: { response: { content: selectedScenario.finalResponses[0] } },
            status: 200,
          },
        },
      ]),
      {
        finalResponseCount: 1,
        model: 'aimock/gpt-5.5',
        promptRequestCount: 1,
        provider: 'aimock',
        requestCount: 1,
        responsesApiRequestCount: 1,
        scenario: 'guided-assignment',
        schemaVersion: 2,
        strictMissCount: 0,
        successfulFixtureResponseCount: 1,
        tools: [],
      },
    );
  });

  it('should normalize execution tool loops with a guided retirement checkpoint', () => {
    for (const scenarioId of ['implementation', 'pr-lifecycle', 'comment', 'retirement']) {
      const selectedScenario = resolveGitHubNotificationModelScenario(scenarioId);
      const hasComment = scenarioId === 'pr-lifecycle' || scenarioId === 'comment';
      const prompt = selectedScenario.systemPromptSignals.join('\n');
      const [reply, issue, patch, add, commit] = selectedScenario.toolCalls;
      const toolNames = [
        'agent_system_github_reply',
        'agent_system_github',
        'apply_patch',
        'agent_system_git',
      ];
      type EvidenceEntry = Parameters<typeof openClawAIMockEvidence>[1][number];
      const messages: NonNullable<EvidenceEntry['body']>['messages'] = [
        { content: prompt, role: 'system' },
      ];
      const entries: EvidenceEntry[] = [];
      const requestForFixture = (
        fixture: NonNullable<EvidenceEntry['response']['fixture']>,
      ): EvidenceEntry => ({
        body: {
          messages: structuredClone(messages),
          model: 'gpt-5.5',
          tools: toolNames.map((name) => ({ function: { name } })),
        },
        method: 'POST',
        path: '/v1/responses',
        response: { fixture, status: 200 },
      });
      const request = (response: Record<string, unknown>): EvidenceEntry =>
        requestForFixture({ response });
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
      if (!reply || !issue || !patch || !add || !commit || !messages) {
        throw new Error(`The ${scenarioId} scenario tool contract is incomplete.`);
      }

      entries.push(request({}));
      appendCall(reply);
      entries.push(request({ content: selectedScenario.finalResponses[0] }));
      if (scenarioId === 'retirement') {
        messages.splice(0, messages.length, { content: prompt, role: 'system' });
        entries.push(request({ content: selectedScenario.finalResponses[3] }));
        messages.splice(0, messages.length, { content: 'host restart recovery', role: 'user' });
        entries.push(request({ content: 'NO_REPLY' }));
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
      messages.splice(0, messages.length, { content: prompt, role: 'system' });
      entries.push(request({ content: selectedScenario.finalResponses[2] }));
      if (hasComment) {
        const dynamicFinalResponseFixture = selectedScenario.dynamicFinalResponseFixtures?.[0];
        if (!dynamicFinalResponseFixture) {
          throw new Error(`The ${scenarioId} scenario dynamic final response is missing.`);
        }
        messages.splice(0, messages.length, { content: prompt, role: 'system' });
        entries.push(requestForFixture(dynamicFinalResponseFixture));
      }

      const hasFourthResponse = hasComment || scenarioId === 'retirement';
      const promptRequestCount = hasFourthResponse ? 9 : 8;
      const requestCount = promptRequestCount + (scenarioId === 'retirement' ? 1 : 0);

      assert.deepEqual(openClawAIMockEvidence(selectedScenario, entries), {
        finalResponseCount: scenarioId === 'retirement' ? 5 : hasFourthResponse ? 4 : 3,
        model: 'aimock/gpt-5.5',
        promptRequestCount,
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
            callResponseCount: 1,
            name: 'agent_system_github_reply',
            projectionRequestCount: requestCount,
            resultRequestCount: 1,
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

  it('should count only scenario-owned static and dynamic final responses', () => {
    const selectedScenario = resolveGitHubNotificationModelScenario('comment');
    const dynamicFinalResponseFixture = selectedScenario.dynamicFinalResponseFixtures?.[0];
    if (!dynamicFinalResponseFixture) {
      throw new Error('The comment scenario dynamic final response is missing.');
    }
    const entry = (
      fixture: Parameters<typeof openClawAIMockEvidence>[1][number]['response']['fixture'],
    ) => ({
      body: { messages: [], model: 'gpt-5.5', tools: [] },
      method: 'POST',
      path: '/responses',
      response: { fixture, status: 200 },
    });

    const evidence = openClawAIMockEvidence(selectedScenario, [
      entry({ response: { content: selectedScenario.finalResponses[0] } }),
      entry({ response: { content: 'unrelated string response' } }),
      entry(dynamicFinalResponseFixture),
      entry({ response: dynamicFinalResponseFixture.response }),
    ]);

    assert.equal(evidence.finalResponseCount, 2);
  });

  it('should report unmatched requests without inventing successful evidence', () => {
    const evidence = openClawAIMockEvidence(scenario, [
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
        {
          callResponseCount: 0,
          name: 'sessions',
          projectionRequestCount: 0,
          resultRequestCount: 0,
        },
      ],
    });
  });
});
