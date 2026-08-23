import assert from 'node:assert/strict';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import GitHubNotificationAssignmentPlanningOrchestrator from '../channels/github/conversation/assignment-planning-orchestrator.ts';
import {
  createGitHubNotificationConversationState,
  type GitHubNotificationConversationState,
} from '../channels/github/conversation/conversation-state.ts';
import type { GitHubNotificationAssignmentInspection } from '../channels/github/intake/assignment-provider.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/intake/monitor/state.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import GitHubNotificationLifecycleRegistry from '../channels/github/lifecycles/registry.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import type { GitHubNotificationItemContextClient } from '../channels/github/provider/work-event-client.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';

function preparedMonitor(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  state.agentId = agentId;
  state.workspaceDir = workspaceDir;
  const intake = state.items[notificationItemKey]?.intake;
  assert.ok(intake);
  state.items[notificationItemKey]!.intake = {
    ...intake,
    stage: 'prepared',
    worktreeBranch: 'issue-12',
    worktreePath: '/workspace/worktrees/issue-12',
  };
  return state;
}

function memoryStateStore(initial: GitHubNotificationConversationState) {
  let state = structuredClone(initial);
  return {
    async read() {
      return structuredClone(state);
    },
    snapshot() {
      return structuredClone(state);
    },
    async write(next: GitHubNotificationConversationState) {
      state = structuredClone(next);
    },
  };
}

function lifecycles() {
  return new GitHubNotificationLifecycleRegistry([
    new GitHubIssueLifecycle({
      async inspectGitHub() {
        return undefined;
      },
      async prepareGitHub() {
        throw new Error('not used');
      },
    }),
  ]);
}

describe('channels/github/conversation/assignment-planning-orchestrator', () => {
  it('should publish one typed plan for a prepared assignment and remain idempotent', async () => {
    const monitor = preparedMonitor();
    const item = monitor.items[notificationItemKey]!;
    const intake = item.intake!;
    const conversationId = githubNotificationConversationId({
      itemNumber: item.number,
      lifecycleId: item.lifecycleId,
      repositoryId: item.repositoryNodeId,
    });
    const initial = createGitHubNotificationConversationState(agentId, workspaceDir);
    initial.conversations[conversationId] = {
      baselineEstablished: false,
      itemKey: notificationItemKey,
      lifecycleId: 'issue',
      mode: 'work',
      revisions: {},
    };
    const conversations = memoryStateStore(initial);
    const calls: unknown[][] = [];
    const contextClient: GitHubNotificationItemContextClient = {
      async getItemContext(owner, name, number, itemType) {
        calls.push(['context', owner, name, number, itemType]);
        return {
          body: 'Saving the form currently produces an error instead of the updated result.',
          comments: [],
          labels: ['bug'],
          title: 'Save the updated form',
          truncated: false,
        };
      },
    };
    const authority = {
      async open(): Promise<
        GitHubNotificationAssignmentInspection<GitHubNotificationItemContextClient>
      > {
        return {
          authorized: true,
          client: contextClient,
          configuration: {
            assignmentTypes: ['issue'],
            approvedActors: [],
            intervalMinutes: 5,
          },
        };
      },
    };
    const orchestrator = new GitHubNotificationAssignmentPlanningOrchestrator({
      assignmentAuthority: authority,
      conversationStateStore: conversations,
      initialMode: githubNotificationWorkMode,
      lifecycles: lifecycles(),
      logger: {
        debug() {},
        error() {},
        info(message) {
          calls.push(['info', message]);
        },
        warn() {},
      },
      monitorStateStore: {
        async read() {
          return structuredClone(monitor);
        },
      },
      publications: {
        async publish(input) {
          calls.push(['publish', input]);
          return {
            receipt: { databaseId: 501, nodeId: 'IC_plan' },
            status: 'published' as const,
            target: input.target,
          };
        },
      },
      turnCatalog: {
        resolve(identity) {
          calls.push(['catalog', identity]);
          return {} as never;
        },
      },
      turns: {
        async respond(input) {
          calls.push([
            'turn',
            input.sourceId,
            input.itemContext.title,
            input.worktree,
            input.mode.policy.label,
          ]);
          return {
            privateText:
              '## Assessment\n\nThe user needs the form to save successfully.\n\n## Plan\n\nUpdate the owning behavior and verify the save flow.',
            publication: {
              planningOutcome: 'plan' as const,
              publicText:
                'I found the failing save path and have a focused implementation and validation plan.',
              status: 'candidate' as const,
            },
          };
        },
      },
    });

    await orchestrator.reconcile(agentId, notificationItemKey, {
      executionSurface: 'gateway',
    });
    await orchestrator.reconcile(agentId, notificationItemKey, {
      executionSurface: 'gateway',
    });

    const planning = conversations.snapshot().conversations[conversationId]!.planning;
    assert.deepEqual(planning, {
      outcome: 'plan',
      publication: {
        commentDatabaseId: 501,
        commentNodeId: 'IC_plan',
        publicText:
          'I found the failing save path and have a focused implementation and validation plan.',
        publicTextDigest: planning?.publication.publicTextDigest,
        status: 'published',
        target: planning?.publication.target,
      },
      sourceId: intake.assignmentEventId,
    });
    assert.equal(conversations.snapshot().conversations[conversationId]!.activeTurn, undefined);
    assert.deepEqual(
      calls.filter(([kind]) => kind === 'turn'),
      [
        [
          'turn',
          intake.assignmentEventId,
          'Save the updated form',
          { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
          'Work',
        ],
      ],
    );
    assert.equal(calls.filter(([kind]) => kind === 'publish').length, 1);
  });
});
