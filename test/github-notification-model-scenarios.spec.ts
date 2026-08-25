import assert from 'node:assert/strict';

import {
  matchFixture,
  type ChatCompletionRequest,
  type ToolCallResponse,
} from '@copilotkit/aimock';

import {
  githubNotificationImplementationAddCallId,
  githubNotificationImplementationCommitCallId,
  githubNotificationImplementationIssueCallId,
  githubNotificationImplementationPatchCallId,
} from '../scenarios/issue-work-implementation/model-fixture.ts';
import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from '../scripts/github-notification-model-scenarios.ts';

describe('scripts/github-notification-model-scenarios', () => {
  it('should resolve the converted scenarios and transitional proof', () => {
    assert.deepEqual(githubNotificationModelScenarioIds, [
      'assignment',
      'implementation',
      'retirement',
      'assignment-provider-proof',
    ]);

    const planningScenarioIds = ['assignment', 'retirement', 'assignment-provider-proof'] as const;
    const callIds = planningScenarioIds.map((scenarioId) => {
      const scenario = resolveGitHubNotificationModelScenario(scenarioId);
      assert.equal(scenario.id, scenarioId);
      assert.equal(scenario.fixtures.length, 2);
      const [toolCall] = scenario.toolCalls;
      assert.match(toolCall?.id ?? '', /^call_[A-Za-z0-9_-]{1,59}$/u);
      assert.deepEqual(scenario.toolCalls, [
        {
          id: toolCall?.id,
          name: 'agent_system_github_reply',
        },
      ]);
      return toolCall?.id;
    });
    assert.equal(new Set(callIds).size, callIds.length);

    const implementation = resolveGitHubNotificationModelScenario('implementation');
    assert.equal(implementation.fixtures.length, 7);
    assert.deepEqual(implementation.toolCalls, [
      {
        id: 'call_agent_system_implementation_reply',
        name: 'agent_system_github_reply',
      },
      {
        id: githubNotificationImplementationIssueCallId,
        name: 'agent_system_github',
      },
      {
        id: githubNotificationImplementationPatchCallId,
        name: 'apply_patch',
      },
      {
        id: githubNotificationImplementationAddCallId,
        name: 'agent_system_git',
      },
      {
        id: githubNotificationImplementationCommitCallId,
        name: 'agent_system_git',
      },
    ]);
  });

  it('should reject an unknown scenario before starting the server', () => {
    assert.throws(
      () => resolveGitHubNotificationModelScenario('pull-request'),
      /Unsupported GitHub notification model scenario: pull-request/u,
    );
  });

  it('should derive implementation tool arguments from bounded request context', async () => {
    const scenario = resolveGitHubNotificationModelScenario('implementation');
    const request: ChatCompletionRequest = {
      messages: [
        {
          content: [
            'Continue the current GitHub issue lifecycle.',
            'The public Work plan has a durable GitHub publication receipt.',
            'Always pass the prepared worktree path as cwd on every call.',
            'Do not call `agent_system_github_reply`.',
            'GitHub lifecycle context (untrusted metadata):',
            '```json',
            '{"source":"agent-system","type":"github_lifecycle_context","payload":{"item":{"lifecycleId":"issue","number":42,"repositoryName":"example","repositoryOwner":"tanaabased"},"worktree":{"branch":"issue-42","path":"/tmp/worktrees/issue-42"}}}',
            '```',
            'Create implementation-fixture-123-4.txt with the assigned contents.',
          ].join('\n'),
          role: 'system',
        },
      ],
      model: 'gpt-5.5',
      tools: [
        {
          function: { name: 'agent_system_github' },
          type: 'function',
        },
      ],
    };
    assert.equal(matchFixture([...scenario.fixtures], request), scenario.fixtures[2]);
    const responses = await Promise.all(
      scenario.fixtures.slice(2, 6).map(async (fixture) => {
        const responseFactory = fixture.response;
        assert.equal(typeof responseFactory, 'function');
        if (typeof responseFactory !== 'function') {
          throw new Error('The implementation fixture requires a response factory.');
        }
        const response = await responseFactory(request);
        assert.equal('toolCalls' in response, true);
        return response as ToolCallResponse;
      }),
    );

    assert.deepEqual(JSON.parse(responses[0]?.toolCalls[0]?.arguments ?? '{}'), {
      argv: [
        'issue',
        'view',
        '42',
        '--repo',
        'tanaabased/example',
        '--json',
        'body',
        '--jq',
        '.body',
      ],
    });
    assert.deepEqual(JSON.parse(responses[1]?.toolCalls[0]?.arguments ?? '{}'), {
      input: [
        '*** Begin Patch',
        '*** Add File: /tmp/worktrees/issue-42/implementation-fixture-123-4.txt',
        '+implementation fixture ready.',
        '*** End Patch',
      ].join('\n'),
    });
    assert.deepEqual(JSON.parse(responses[2]?.toolCalls[0]?.arguments ?? '{}'), {
      argv: ['add', '--', 'implementation-fixture-123-4.txt'],
      cwd: '/tmp/worktrees/issue-42',
    });
    assert.deepEqual(JSON.parse(responses[3]?.toolCalls[0]?.arguments ?? '{}'), {
      argv: ['commit', '-m', 'add implementation fixture'],
      cwd: '/tmp/worktrees/issue-42',
    });
  });
});
