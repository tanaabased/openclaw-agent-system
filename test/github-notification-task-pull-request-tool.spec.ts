import assert from 'node:assert/strict';

import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';

import AgentSystemToolError from '../api/error.ts';
import type { AgentSystemToolScope } from '../api/types.ts';
import { githubNotificationConversationId } from '../channels/github/channel.ts';
import { createGitHubNotificationConversationSnapshot } from '../channels/github/conversation/conversation-state.ts';
import {
  GitHubIssueDeliveryError,
  type default as GitHubNotificationIssueDeliveryService,
} from '../channels/github/conversation/issue-delivery-service.ts';
import type GitHubNotificationPullRequestHandoffService from '../channels/github/conversation/pull-request-handoff-service.ts';
import createGitHubNotificationTaskPullRequestTool from '../channels/github/publication/task-pull-request-tool.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

describe('channels/github/publication/task-pull-request-tool', () => {
  it('should expose only an issue-owned tool and checkpoint an authorized PR after publication', async () => {
    const agentId = 'tanaabot';
    const workspaceDir = '/workspace';
    const monitor = notificationMonitorState();
    const item = monitor.items[notificationItemKey]!;
    item.intake = {
      ...item.intake!,
      stage: 'prepared',
      worktreeBranch: 'issue-12',
      worktreePath: '/worktrees/issue-12',
    };
    const conversationId = githubNotificationConversationId({
      itemNumber: item.number,
      lifecycleId: 'issue',
      repositoryId: item.repositoryNodeId,
    });
    const snapshot = createGitHubNotificationConversationSnapshot(
      agentId,
      workspaceDir,
      conversationId,
    );
    snapshot.conversation = {
      assignmentResponse: { reasonCode: 'github-notification-guided-waiting', status: 'withheld' },
      baselineEstablished: true,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'guided',
      revisions: {},
    };
    const calls: string[] = [];
    let authorized = true;
    let failPublication = false;
    let failCheckpoint = false;
    let handoffStatus: 'awaiting-reconciliation' | 'published' = 'awaiting-reconciliation';
    const dependencies: Parameters<typeof createGitHubNotificationTaskPullRequestTool>[0] = {
      conversations: {
        async readRouted() {
          return snapshot;
        },
      },
      monitor: {
        async read() {
          return monitor;
        },
      },
      services: () =>
        ({
          authority: {
            async open() {
              calls.push('authorize');
              return authorized ? { authorized: true } : { authorized: false };
            },
          },
          delivery: {
            async publishTaskPullRequest(
              input: Parameters<
                GitHubNotificationIssueDeliveryService['publishTaskPullRequest']
              >[0],
            ) {
              calls.push('publish');
              if (failPublication)
                throw new GitHubIssueDeliveryError('invalid-response', 'raw private response');
              assert.equal(input.worktree.branch, 'issue-12');
              assert.equal(input.title, 'Ready for review');
              return { pullRequestNodeId: 'PR_task', pullRequestNumber: 45 };
            },
          },
          handoff: {
            async checkpointTask(
              input: Parameters<GitHubNotificationPullRequestHandoffService['checkpointTask']>[0],
            ) {
              calls.push('checkpoint');
              if (failCheckpoint) throw new Error('raw private checkpoint data');
              assert.deepEqual(input.pullRequest, {
                pullRequestNodeId: 'PR_task',
                pullRequestNumber: 45,
              });
              return handoffStatus;
            },
          },
        }) as never,
    };
    const registered = createGitHubNotificationTaskPullRequestTool(dependencies);
    let factory: OpenClawPluginToolFactory | undefined;
    registered.registerTools(
      {
        registerTool(value: unknown) {
          factory = value as OpenClawPluginToolFactory;
        },
      } as never,
      {
        async executeSemantic(definition: unknown, input: unknown, scope: AgentSystemToolScope) {
          const executable = definition as {
            execute(input: unknown, configuration: unknown, scope: unknown): Promise<unknown>;
          };
          const output = await executable.execute(
            input,
            {},
            {
              ...scope,
              agentId,
              workspaceDir,
              resolveEnvironment: () => undefined,
            },
          );
          return {
            auditId: 'audit-1',
            kind: 'semantic',
            operation: { action: 'publish-task-pr', risk: 'write', summary: 'Publish task PR.' },
            output,
          };
        },
      } as never,
    );
    assert.ok(factory);
    assert.equal(factory({ agentId, sessionKey: 'unrelated-session' }), null);
    assert.equal(
      factory({
        agentId,
        sessionKey: `agent:${agentId}:agent-system-github:${agentId}:direct:github:issue:R_repo:9007199254740993`,
      }),
      null,
    );
    const tool = factory({
      agentId,
      messageChannel: 'webchat',
      sessionKey: `agent:${agentId}:agent-system-github:${agentId}:direct:${conversationId}`,
    });
    assert.ok(tool && !Array.isArray(tool));
    const result = await tool.execute('call-1', { title: 'Ready for review' });
    assert.deepEqual((result.details as { output: unknown })?.output, {
      handoffStatus: 'awaiting-reconciliation',
      number: 45,
      status: 'linked',
    });
    assert.deepEqual(calls, ['authorize', 'publish', 'authorize', 'checkpoint']);

    calls.length = 0;
    handoffStatus = 'published';
    const retry = await tool.execute('call-published-retry', { title: 'Ready for review' });
    assert.deepEqual((retry.details as { output: unknown })?.output, {
      handoffStatus: 'published',
      number: 45,
      status: 'linked',
    });
    assert.deepEqual(calls, ['authorize', 'publish', 'authorize', 'checkpoint']);

    calls.length = 0;
    failPublication = true;
    await assert.rejects(
      tool.execute('call-publication', { title: 'Ready for review' }),
      (error: unknown) =>
        error instanceof AgentSystemToolError &&
        error.failureDiagnostic?.stage === 'publication' &&
        error.failureDiagnostic.category === 'invalid-response' &&
        !error.message.includes('raw private'),
    );
    assert.deepEqual(calls, ['authorize', 'publish']);
    failPublication = false;

    calls.length = 0;
    failCheckpoint = true;
    await assert.rejects(
      tool.execute('call-checkpoint', { title: 'Ready for review' }),
      (error: unknown) =>
        error instanceof AgentSystemToolError &&
        error.failureDiagnostic?.stage === 'checkpoint' &&
        error.failureDiagnostic.category === 'checkpoint-failed' &&
        !error.message.includes('raw private'),
    );
    assert.deepEqual(calls, ['authorize', 'publish', 'authorize', 'checkpoint']);
    failCheckpoint = false;

    calls.length = 0;
    authorized = false;
    await assert.rejects(
      tool.execute('call-2', { title: 'Ready for review' }),
      (error: unknown) =>
        error instanceof AgentSystemToolError &&
        error.failureDiagnostic?.stage === 'authorization' &&
        error.failureDiagnostic.category === 'authority-revoked',
    );
    assert.deepEqual(calls, ['authorize']);
    authorized = true;
    calls.length = 0;
    snapshot.conversation.activeTurn = { eventId: 'assignment', sourceId: 'EV_assignment' };
    await assert.rejects(tool.execute('call-3', { title: 'Ready for review' }));
    assert.deepEqual(calls, []);
  });
});
