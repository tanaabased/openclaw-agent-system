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
import {
  githubNotificationPullRequestAddCallId,
  githubNotificationPullRequestCommitCallId,
  githubNotificationPullRequestIssueCallId,
  githubNotificationPullRequestPatchCallId,
  githubNotificationPullRequestReplyCallId,
} from '../scenarios/issue-work-pr/model-fixture.ts';
import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from '../scripts/github-notification-model-scenarios.ts';

describe('scripts/github-notification-model-scenarios', () => {
  it('should resolve the converted scenarios and transitional proof', () => {
    assert.deepEqual(githubNotificationModelScenarioIds, [
      'assignment',
      'implementation',
      'pr',
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

    const executionScenarios = [
      {
        callIds: [
          'call_agent_system_implementation_reply',
          githubNotificationImplementationIssueCallId,
          githubNotificationImplementationPatchCallId,
          githubNotificationImplementationAddCallId,
          githubNotificationImplementationCommitCallId,
        ],
        id: 'implementation',
      },
      {
        callIds: [
          githubNotificationPullRequestReplyCallId,
          githubNotificationPullRequestIssueCallId,
          githubNotificationPullRequestPatchCallId,
          githubNotificationPullRequestAddCallId,
          githubNotificationPullRequestCommitCallId,
        ],
        id: 'pr',
      },
    ] as const;
    for (const executionScenario of executionScenarios) {
      const scenario = resolveGitHubNotificationModelScenario(executionScenario.id);
      assert.equal(scenario.fixtures.length, 7);
      assert.deepEqual(scenario.toolCalls, [
        { id: executionScenario.callIds[0], name: 'agent_system_github_reply' },
        { id: executionScenario.callIds[1], name: 'agent_system_github' },
        { id: executionScenario.callIds[2], name: 'apply_patch' },
        { id: executionScenario.callIds[3], name: 'agent_system_git' },
        { id: executionScenario.callIds[4], name: 'agent_system_git' },
      ]);
    }
  });

  it('should reject an unknown scenario before starting the server', () => {
    assert.throws(
      () => resolveGitHubNotificationModelScenario('comment'),
      /Unsupported GitHub notification model scenario: comment/u,
    );
  });

  it('should derive issue work tool arguments from bounded request context', async () => {
    const executionScenarios = [
      {
        commitMessage: 'add implementation fixture',
        fileContents: 'implementation fixture ready.',
        filename: 'implementation-fixture-123-4.txt',
        id: 'implementation',
      },
      {
        commitMessage: 'add pull request fixture',
        fileContents: 'pull request fixture ready.',
        filename: 'pull-request-fixture-123-4.txt',
        id: 'pr',
      },
    ] as const;

    for (const executionScenario of executionScenarios) {
      const scenario = resolveGitHubNotificationModelScenario(executionScenario.id);
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
              `Create ${executionScenario.filename} with the assigned contents.`,
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
            throw new Error('The issue work fixture requires a response factory.');
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
          `*** Add File: /tmp/worktrees/issue-42/${executionScenario.filename}`,
          `+${executionScenario.fileContents}`,
          '*** End Patch',
        ].join('\n'),
      });
      assert.deepEqual(JSON.parse(responses[2]?.toolCalls[0]?.arguments ?? '{}'), {
        argv: ['add', '--', executionScenario.filename],
        cwd: '/tmp/worktrees/issue-42',
      });
      assert.deepEqual(JSON.parse(responses[3]?.toolCalls[0]?.arguments ?? '{}'), {
        argv: ['commit', '-m', executionScenario.commitMessage],
        cwd: '/tmp/worktrees/issue-42',
      });
    }
  });
});
