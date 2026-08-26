import assert from 'node:assert/strict';

import {
  matchFixture,
  type ChatCompletionRequest,
  type ToolCallResponse,
} from '@copilotkit/aimock';

import { githubNotificationAssignmentCallId } from '../scenarios/issue-work-assignment/model-fixture.ts';
import {
  githubNotificationImplementationAddCallId,
  githubNotificationImplementationCommitCallId,
  githubNotificationImplementationIssueCallId,
  githubNotificationImplementationPatchCallId,
} from '../scenarios/issue-work-implementation/model-fixture.ts';
import {
  githubNotificationCommentAddCallId,
  githubNotificationCommentAssignmentReplyCallId,
  githubNotificationCommentCommitCallId,
  githubNotificationCommentIssueCallId,
  githubNotificationCommentPatchCallId,
  githubNotificationCommentReplyCallId,
} from '../scenarios/issue-work-comment/model-fixture.ts';
import {
  githubNotificationPullRequestContinuationAddCallId,
  githubNotificationPullRequestContinuationCommentReplyCallId,
  githubNotificationPullRequestContinuationCommitCallId,
  githubNotificationPullRequestContinuationIssueCallId,
  githubNotificationPullRequestContinuationPatchCallId,
  githubNotificationPullRequestContinuationReplyCallId,
} from '../scenarios/issue-work-pr-continuation/model-fixture.ts';
import {
  githubNotificationPullRequestHandoffAddCallId,
  githubNotificationPullRequestHandoffCommitCallId,
  githubNotificationPullRequestHandoffIssueCallId,
  githubNotificationPullRequestHandoffPatchCallId,
  githubNotificationPullRequestHandoffReplyCallId,
} from '../scenarios/issue-work-pr-handoff/model-fixture.ts';
import {
  githubNotificationPullRequestRetirementAddCallId,
  githubNotificationPullRequestRetirementCommitCallId,
  githubNotificationPullRequestRetirementIssueCallId,
  githubNotificationPullRequestRetirementPatchCallId,
  githubNotificationPullRequestRetirementReplyCallId,
} from '../scenarios/issue-work-pr-retirement/model-fixture.ts';
import {
  githubNotificationRetirementAddCallId,
  githubNotificationRetirementCommitCallId,
  githubNotificationRetirementIssueCallId,
  githubNotificationRetirementPatchCallId,
  githubNotificationRetirementReplyCallId,
} from '../scenarios/issue-work-retirement/model-fixture.ts';
import resolveGitHubNotificationModelScenario, {
  githubNotificationModelScenarioIds,
} from '../scripts/github-notification-model-scenarios.ts';
import { githubNotificationPullRequestOpenedFinalResponse } from '../scripts/github-notification-model-issue-work-scenario.ts';

describe('scripts/github-notification-model-scenarios', () => {
  it('should resolve the seven provider-neutral scenarios', () => {
    assert.deepEqual(githubNotificationModelScenarioIds, [
      'assignment',
      'implementation',
      'pr-handoff',
      'pr-continuation',
      'pr-retirement',
      'comment',
      'retirement',
    ]);

    const planningScenarioIds = ['assignment'] as const;
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
          githubNotificationPullRequestHandoffReplyCallId,
          githubNotificationPullRequestHandoffIssueCallId,
          githubNotificationPullRequestHandoffPatchCallId,
          githubNotificationPullRequestHandoffAddCallId,
          githubNotificationPullRequestHandoffCommitCallId,
        ],
        id: 'pr-handoff',
      },
      {
        callIds: [
          githubNotificationPullRequestContinuationReplyCallId,
          githubNotificationPullRequestContinuationIssueCallId,
          githubNotificationPullRequestContinuationPatchCallId,
          githubNotificationPullRequestContinuationAddCallId,
          githubNotificationPullRequestContinuationCommitCallId,
        ],
        id: 'pr-continuation',
      },
      {
        callIds: [
          githubNotificationPullRequestRetirementReplyCallId,
          githubNotificationPullRequestRetirementIssueCallId,
          githubNotificationPullRequestRetirementPatchCallId,
          githubNotificationPullRequestRetirementAddCallId,
          githubNotificationPullRequestRetirementCommitCallId,
        ],
        id: 'pr-retirement',
      },
      {
        callIds: [
          githubNotificationCommentAssignmentReplyCallId,
          githubNotificationCommentIssueCallId,
          githubNotificationCommentPatchCallId,
          githubNotificationCommentAddCallId,
          githubNotificationCommentCommitCallId,
        ],
        id: 'comment',
      },
      {
        callIds: [
          githubNotificationRetirementReplyCallId,
          githubNotificationRetirementIssueCallId,
          githubNotificationRetirementPatchCallId,
          githubNotificationRetirementAddCallId,
          githubNotificationRetirementCommitCallId,
        ],
        id: 'retirement',
      },
    ] as const;
    for (const executionScenario of executionScenarios) {
      const scenario = resolveGitHubNotificationModelScenario(executionScenario.id);
      assert.equal(
        scenario.fixtures.length,
        executionScenario.id === 'comment' || executionScenario.id === 'pr-continuation' ? 10 : 8,
      );
      const expectedToolCalls: Array<{ id: string; name: string }> = [
        { id: executionScenario.callIds[0], name: 'agent_system_github_reply' },
        { id: executionScenario.callIds[1], name: 'agent_system_github' },
        { id: executionScenario.callIds[2], name: 'apply_patch' },
        { id: executionScenario.callIds[3], name: 'agent_system_git' },
        { id: executionScenario.callIds[4], name: 'agent_system_git' },
      ];
      if (executionScenario.id === 'comment' || executionScenario.id === 'pr-continuation') {
        expectedToolCalls.push({
          id:
            executionScenario.id === 'comment'
              ? githubNotificationCommentReplyCallId
              : githubNotificationPullRequestContinuationCommentReplyCallId,
          name: 'agent_system_github_reply',
        });
      }
      assert.deepEqual(scenario.toolCalls, expectedToolCalls);
    }

    const comment = resolveGitHubNotificationModelScenario('comment');
    assert.equal(comment.fixtures.length, 10);
    assert.deepEqual(comment.toolCalls[5], {
      id: githubNotificationCommentReplyCallId,
      name: 'agent_system_github_reply',
    });
  });

  it('should reject an unknown scenario before starting the server', () => {
    assert.throws(
      () => resolveGitHubNotificationModelScenario('unsupported'),
      /Unsupported GitHub notification model scenario: unsupported/u,
    );
  });

  it('should require bounded issue content for the assignment fixture', () => {
    const scenario = resolveGitHubNotificationModelScenario('assignment');
    const userPromptSignals = scenario.userPromptSignals ?? [];
    assert.deepEqual(userPromptSignals, [
      'add assignment planning fixture',
      'Create assignment-planning-',
      'assignment planning ready.',
    ]);
    const request: ChatCompletionRequest = {
      messages: [
        {
          content: scenario.systemPromptSignals.join('\n'),
          role: 'system',
        },
        { content: userPromptSignals.join('\n'), role: 'user' },
      ],
      model: 'gpt-5.5',
      tools: [
        {
          function: { name: 'agent_system_github_reply' },
          type: 'function',
        },
      ],
    };

    assert.equal(matchFixture([...scenario.fixtures], request), scenario.fixtures[0]);
    assert.deepEqual(scenario.toolCalls, [
      {
        id: githubNotificationAssignmentCallId,
        name: 'agent_system_github_reply',
      },
    ]);
    request.messages[1]!.content = userPromptSignals
      .filter((signal) => signal !== 'Create assignment-planning-')
      .join('\n');
    assert.equal(matchFixture([...scenario.fixtures], request), null);
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
        id: 'pr-handoff',
      },
      {
        commitMessage: 'add pull request fixture',
        fileContents: 'pull request fixture ready.',
        filename: 'pull-request-fixture-123-4.txt',
        id: 'pr-continuation',
      },
      {
        commitMessage: 'add pull request retirement fixture',
        fileContents: 'pull request retirement fixture ready.',
        filename: 'pull-request-retirement-fixture-123-4.txt',
        id: 'pr-retirement',
      },
      {
        commitMessage: 'add comment fixture',
        fileContents: 'comment fixture ready.',
        filename: 'comment-fixture-123-4.txt',
        id: 'comment',
      },
      {
        commitMessage: 'add completed retirement fixture',
        fileContents: 'completed retirement fixture ready.',
        filename: 'completed-retirement-fixture-123-4.txt',
        id: 'retirement',
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

  it('should provide one deterministic private response for the pull request opened event', () => {
    for (const scenarioId of [
      'implementation',
      'pr-handoff',
      'pr-continuation',
      'pr-retirement',
      'comment',
      'retirement',
    ]) {
      const scenario = resolveGitHubNotificationModelScenario(scenarioId);
      const request: ChatCompletionRequest = {
        messages: [
          {
            content: [
              'Continue the current GitHub issue lifecycle.',
              'A delivery pull request has been linked to the current issue-owned work session.',
              'Respond privately with one brief acknowledgment.',
            ].join('\n'),
            role: 'system',
          },
        ],
        model: 'gpt-5.5',
      };

      const fixture = scenario.fixtures[7];
      assert.equal(matchFixture([...scenario.fixtures], request), fixture);
      assert.deepEqual(fixture?.response, {
        content: githubNotificationPullRequestOpenedFinalResponse,
        id: `agent-system-notification-${scenarioId}-pull-request-opened-final-response`,
      });
    }
  });

  it('should derive source comment replies from admitted tokens across continuation history', async () => {
    const cases = [
      {
        callId: githubNotificationCommentReplyCallId,
        scenarioId: 'comment',
        token: 'ready-123-4',
      },
      {
        callId: githubNotificationPullRequestContinuationCommentReplyCallId,
        scenarioId: 'pr-continuation',
        token: 'pr-ready-123-4',
      },
    ] as const;
    for (const entry of cases) {
      const scenario = resolveGitHubNotificationModelScenario(entry.scenarioId);
      const request: ChatCompletionRequest = {
        messages: [
          {
            content: [
              'Continue the current GitHub issue lifecycle.',
              'The approved inbound comment is the current user request.',
              'Place the exact {{commenter}} placeholder once.',
            ].join('\n'),
            role: 'developer',
          } as unknown as ChatCompletionRequest['messages'][number],
          {
            content: `@tanaabot Reply briefly with ${entry.token}.`,
            role: 'user',
          },
          {
            content: null,
            role: 'assistant',
            tool_calls: [
              {
                function: { arguments: '{}', name: 'unrelated_tool' },
                id: 'call_unrelated_history',
                type: 'function',
              },
            ],
          },
          {
            content: '{"status":"complete"}',
            role: 'tool',
            tool_call_id: 'call_unrelated_history',
          },
          {
            content: 'Continue the admitted comment turn.',
            role: 'user',
          },
        ],
        model: 'gpt-5.5',
        tools: [
          {
            function: { name: 'agent_system_github_reply' },
            type: 'function',
          },
        ],
      };
      const replyFixture = scenario.fixtures[8];
      assert.equal(matchFixture([...scenario.fixtures], request), replyFixture);
      const responseFactory = replyFixture?.response;
      assert.equal(typeof responseFactory, 'function');
      if (typeof responseFactory !== 'function') {
        throw new Error('The source comment reply fixture requires a response factory.');
      }
      const response = (await responseFactory(request)) as ToolCallResponse;
      assert.deepEqual(JSON.parse(response.toolCalls[0]?.arguments ?? '{}'), {
        body: `{{commenter}}, ${entry.token}`,
      });

      request.messages.push(
        {
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: response.toolCalls[0]?.arguments ?? '{}',
                name: 'agent_system_github_reply',
              },
              id: entry.callId,
              type: 'function',
            },
          ],
        },
        {
          content: '{"status":"staged"}',
          role: 'tool',
          tool_call_id: entry.callId,
        },
      );
      assert.equal(matchFixture([...scenario.fixtures], request), scenario.fixtures[9]);
    }
  });
});
