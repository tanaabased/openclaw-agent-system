import assert from 'node:assert/strict';

import {
  matchFixture,
  type ChatCompletionRequest,
  type ToolCallResponse,
} from '@copilotkit/aimock';

import githubNotificationAssignmentEventInstructions from '../channels/github/conversation/prompts/event-assignment.ts';
import githubNotificationIssueLifecycleInstructions from '../channels/github/conversation/prompts/lifecycle-issue.ts';
import githubNotificationWorkModeInstructions from '../channels/github/conversation/prompts/mode-work.ts';
import githubNotificationAssignmentResponseInstructions from '../channels/github/conversation/prompts/response-assignment.ts';
import { githubNotificationGuidedAssignmentFinalResponse } from '../scenarios/issue-guided-assignment/model-fixture.ts';
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
} from '../scenarios/issue-work-comment/model-fixture.ts';
import {
  githubNotificationPullRequestLifecycleAddCallId,
  githubNotificationPullRequestLifecycleCommitCallId,
  githubNotificationPullRequestLifecycleIssueCallId,
  githubNotificationPullRequestLifecyclePatchCallId,
  githubNotificationPullRequestLifecycleReplyCallId,
} from '../scenarios/issue-work-pr-lifecycle/model-fixture.ts';
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
  it('should resolve the six provider-neutral scenarios', () => {
    assert.deepEqual(githubNotificationModelScenarioIds, [
      'assignment',
      'guided-assignment',
      'implementation',
      'pr-lifecycle',
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

    const guidedAssignment = resolveGitHubNotificationModelScenario('guided-assignment');
    assert.equal(guidedAssignment.fixtures.length, 1);
    assert.deepEqual(guidedAssignment.finalResponses, [
      githubNotificationGuidedAssignmentFinalResponse,
    ]);
    assert.deepEqual(guidedAssignment.toolCalls, []);

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
          githubNotificationPullRequestLifecycleReplyCallId,
          githubNotificationPullRequestLifecycleIssueCallId,
          githubNotificationPullRequestLifecyclePatchCallId,
          githubNotificationPullRequestLifecycleAddCallId,
          githubNotificationPullRequestLifecycleCommitCallId,
        ],
        id: 'pr-lifecycle',
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
      const expectedFixtureCount =
        executionScenario.id === 'retirement'
          ? 10
          : executionScenario.id === 'implementation'
            ? 8
            : 9;
      assert.equal(scenario.fixtures.length, expectedFixtureCount);
      const expectedToolCalls: Array<{ id: string; name: string }> = [
        { id: executionScenario.callIds[0], name: 'agent_system_github_reply' },
        { id: executionScenario.callIds[1], name: 'agent_system_github' },
        { id: executionScenario.callIds[2], name: 'apply_patch' },
        { id: executionScenario.callIds[3], name: 'agent_system_git' },
        { id: executionScenario.callIds[4], name: 'agent_system_git' },
      ];
      assert.deepEqual(scenario.toolCalls, expectedToolCalls);
    }

    const comment = resolveGitHubNotificationModelScenario('comment');
    assert.equal(comment.fixtures.length, 9);
    assert.equal(comment.toolCalls.length, 5);
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

  it('should require guided assignment context without a public reply tool call', () => {
    const scenario = resolveGitHubNotificationModelScenario('guided-assignment');
    const request: ChatCompletionRequest = {
      messages: [
        { content: scenario.systemPromptSignals.join('\n'), role: 'system' },
        { content: scenario.userPromptSignals?.join('\n') ?? '', role: 'user' },
      ],
      model: 'gpt-5.5',
      tools: [{ function: { name: 'agent_system_github_reply' }, type: 'function' }],
    };

    assert.equal(matchFixture([...scenario.fixtures], request), scenario.fixtures[0]);
    assert.deepEqual(scenario.toolCalls, []);
    request.messages[1]!.content = 'missing guided assignment evidence';
    assert.equal(matchFixture([...scenario.fixtures], request), null);
  });

  it('should keep the incomplete retirement checkpoint in guided mode', () => {
    const scenario = resolveGitHubNotificationModelScenario('retirement');
    const request: ChatCompletionRequest = {
      messages: [
        {
          content: [
            'Continue the current GitHub issue lifecycle',
            'Guided mode is operator-led',
            'The initial assignment authorizes setup and acknowledgment, not implementation',
            'do not call the tool because the deterministic assignment acknowledgment is the complete public response',
          ].join('\n'),
          role: 'system',
        },
        {
          content:
            'add retirement fixture\nCreate retirement-fixture-123-4.txt with the assigned contents.',
          role: 'user',
        },
      ],
      model: 'gpt-5.5',
      tools: [{ function: { name: 'agent_system_github_reply' }, type: 'function' }],
    };

    assert.equal(matchFixture([...scenario.fixtures], request), scenario.fixtures[0]);
    request.messages[1]!.content =
      'add completed retirement fixture\nCreate completed-retirement-fixture-123-4.txt.';
    assert.notEqual(matchFixture([...scenario.fixtures], request), scenario.fixtures[0]);
  });

  it('should silently finish restart recovery only for the guided retirement checkpoint', () => {
    const scenario = resolveGitHubNotificationModelScenario('retirement');
    const recoveryPrompt =
      '[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.';
    const request: ChatCompletionRequest = {
      messages: [
        { content: 'OpenClaw runtime guidance', role: 'system' },
        { content: 'add retirement fixture\nCreate retirement-fixture-123-4.txt.', role: 'user' },
        {
          content:
            'The retirement checkpoint is prepared. I am waiting for operator direction before taking action.',
          role: 'assistant',
        },
        { content: 'internal restart context', role: 'user' },
        { content: recoveryPrompt, role: 'user' },
      ],
      model: 'gpt-5.5',
      tools: [{ function: { name: 'agent_system_github_reply' }, type: 'function' }],
    };

    const fixture = matchFixture([...scenario.fixtures], request);
    assert.deepEqual(fixture?.response, {
      content: 'NO_REPLY',
      id: 'agent-system-notification-retirement-restart-recovery-final-response',
    });
    assert.ok(scenario.finalResponses.includes('NO_REPLY'));

    const withRuntimeContext = structuredClone(request);
    withRuntimeContext.messages.push({
      role: 'user',
      content:
        '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nHost runtime instructions.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
    });
    assert.equal(matchFixture([...scenario.fixtures], withRuntimeContext), fixture);
    withRuntimeContext.messages.push({ content: 'A new operator request.', role: 'user' });
    assert.equal(matchFixture([...scenario.fixtures], withRuntimeContext), null);

    const missingAcknowledgment = structuredClone(request);
    missingAcknowledgment.messages[2]!.content = 'An unrelated task finished.';
    const ordinaryComment = structuredClone(request);
    ordinaryComment.messages[4]!.content = 'Please implement the issue now.';
    const staleRecovery = structuredClone(request);
    staleRecovery.messages.push({ content: 'A new operator request.', role: 'user' });
    const wrongModel = { ...request, model: 'unexpected-model' };
    const toolContinuation = structuredClone(request);
    toolContinuation.messages.push({
      content: '{"status":"completed"}',
      role: 'tool',
      tool_call_id: 'call_unexpected',
    });
    for (const [label, unrelatedRequest] of Object.entries({
      missingAcknowledgment,
      ordinaryComment,
      staleRecovery,
      toolContinuation,
      wrongModel,
    })) {
      assert.equal(matchFixture([...scenario.fixtures], unrelatedRequest), null, label);
    }
  });

  it('should match current work assignment guidance across execution scenarios', () => {
    const request: ChatCompletionRequest = {
      messages: [
        {
          content: [
            githubNotificationIssueLifecycleInstructions,
            githubNotificationWorkModeInstructions,
            githubNotificationAssignmentEventInstructions,
            githubNotificationAssignmentResponseInstructions,
          ].join('\n\n'),
          role: 'system',
        },
      ],
      model: 'gpt-5.5',
      tools: [{ function: { name: 'agent_system_github_reply' }, type: 'function' }],
    };

    for (const scenarioId of ['implementation', 'pr-lifecycle', 'comment', 'retirement']) {
      const scenario = resolveGitHubNotificationModelScenario(scenarioId);
      const assignmentFixture = scenario.fixtures[scenarioId === 'retirement' ? 1 : 0];
      assert.equal(matchFixture([...scenario.fixtures], request), assignmentFixture);
    }
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
        commitMessage: 'add pull request lifecycle fixture',
        fileContents: 'pull request lifecycle fixture ready.',
        filename: 'pull-request-lifecycle-fixture-123-4.txt',
        id: 'pr-lifecycle',
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
      const fixtureOffset = executionScenario.id === 'retirement' ? 1 : 0;
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
      assert.equal(
        matchFixture([...scenario.fixtures], request),
        scenario.fixtures[fixtureOffset + 2],
      );
      const responses = await Promise.all(
        scenario.fixtures.slice(fixtureOffset + 2, fixtureOffset + 6).map(async (fixture) => {
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
    for (const scenarioId of ['implementation', 'pr-lifecycle', 'comment', 'retirement']) {
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

      const fixture = scenario.fixtures[scenarioId === 'retirement' ? 8 : 7];
      assert.equal(matchFixture([...scenario.fixtures], request), fixture);
      assert.deepEqual(fixture?.response, {
        content: githubNotificationPullRequestOpenedFinalResponse,
        id: `agent-system-notification-${scenarioId}-pull-request-opened-final-response`,
      });
    }
  });

  it('should derive direct final replies from admitted comment tokens', async () => {
    const cases = [
      {
        scenarioId: 'comment',
        token: 'ready-123-4',
      },
      {
        scenarioId: 'pr-lifecycle',
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
              'Your final response is published back to the exact source comment.',
            ].join('\n'),
            role: 'system',
          },
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
      };
      const replyFixture = scenario.fixtures[8];
      assert.equal(matchFixture([...scenario.fixtures], request), replyFixture);
      const responseFactory = replyFixture?.response;
      assert.equal(typeof responseFactory, 'function');
      if (typeof responseFactory !== 'function') {
        throw new Error('The source comment reply fixture requires a response factory.');
      }
      const response = await responseFactory(request);
      assert.equal(
        'content' in response ? response.content : undefined,
        `{{commenter}}, ${entry.token}`,
      );
    }
  });
});
