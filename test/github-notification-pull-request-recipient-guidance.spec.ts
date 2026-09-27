import assert from 'node:assert/strict';

import type { AgentManifest } from '../manifest/types.ts';
import GitHubNotificationPullRequestRecipientGuidance from '../channels/github/conversation/pull-request-recipient-guidance.ts';
import { approvedNotificationItem, notificationItemKey } from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace/tanaabot';
const baseManifest: AgentManifest = {
  agent: { id: agentId },
  github: { token: 'GITHUB_TOKEN', username: agentId },
  schemaVersion: 1,
};

function guidance(
  options: {
    assignees?: 'assignment-actor' | Array<{ login: string; nodeId: string }>;
    reviewers?: Array<{ login: string; nodeId: string }>;
    item?: ReturnType<typeof approvedNotificationItem>;
    workspaceDir?: string;
  } = {},
) {
  const item = options.item ?? approvedNotificationItem();
  const manifest: AgentManifest = {
    ...baseManifest,
    github: {
      ...baseManifest.github,
      notifications: {
        approvedActors: [],
        assignmentTypes: ['issue'],
        intervalMinutes: 5,
        maxConcurrentIssues: 2,
        pullRequest: {
          assignees: options.assignees ?? 'assignment-actor',
          reviewers: options.reviewers ?? [],
        },
      },
    },
  };
  const service = new GitHubNotificationPullRequestRecipientGuidance({
    conversations: {
      async read() {
        return {
          agentId,
          conversationId: 'github:issue:R_repo:12',
          workspaceDir,
          conversation: {
            activeTurn: { eventId: 'comment', sourceId: 'comment-revision' },
            baselineEstablished: true,
            itemKey: notificationItemKey,
            lifecycleId: 'issue',
            mode: 'work',
            revisions: {},
          },
        };
      },
    },
    manifestService: {
      async loadForAgentId() {
        return {
          diagnostics: [],
          digest: 'manifest-digest',
          manifest,
          path: '/workspace/tanaabot/agent.yaml',
          scope: { agentId, workspaceDir: options.workspaceDir ?? workspaceDir },
          status: 'loaded' as const,
          validationChecks: [],
        };
      },
    },
    monitor: {
      async read() {
        return {
          agentId,
          failureCount: 0,
          items: { [notificationItemKey]: item },
          nextSchedulingSequence: 1,
          processedEventNodeIds: [],
          schemaVersion: 6 as const,
          workspaceDir,
        };
      },
    },
  });
  return { item, service };
}

describe('channels/github/conversation/pull-request-recipient-guidance', () => {
  it('should keep the original assignment actor through a later comment', async () => {
    const { service } = guidance();
    const instructions = await service.forConversation({
      agentId,
      conversationId: 'github:issue:R_repo:12',
    });
    assert.match(instructions, /assignees: @pirog \(node ID U_actor\)/u);
    assert.match(instructions, /reviewers: none/u);
    assert.doesNotMatch(instructions, /comment-revision.*assignee/u);
    assert.match(instructions, /use agent_system_github_task_pr instead of gh pr create/u);
    assert.match(
      instructions,
      /normal implementation turn leaves publication to automatic delivery/u,
    );
    assert.match(instructions, /Report rejected or unresolved settings/u);
  });

  it('should use pinned assignees and reviewers without substituting the actor', async () => {
    const { item, service } = guidance({
      assignees: [{ login: 'owner', nodeId: 'U_owner' }],
      reviewers: [{ login: 'reviewer', nodeId: 'U_reviewer' }],
    });
    const instructions = await service.forItem({ agentId, item, workspaceDir });
    assert.match(
      instructions,
      /assignees: @owner \(node ID U_owner\); reviewers: @reviewer \(node ID U_reviewer\)/u,
    );
    assert.doesNotMatch(instructions, /@pirog/u);
  });

  it('should respect an empty assignee list', async () => {
    const { item, service } = guidance({
      assignees: [],
      reviewers: [{ login: 'reviewer', nodeId: 'U_reviewer' }],
    });
    const instructions = await service.forItem({ agentId, item, workspaceDir });
    assert.match(instructions, /assignees: none; reviewers: @reviewer \(node ID U_reviewer\)/u);
    assert.doesNotMatch(instructions, /@pirog/u);
  });

  it('should report an unresolved assignment actor without substitution', async () => {
    const item = { ...approvedNotificationItem(), assignmentActorNodeId: undefined };
    const { service } = guidance({ item });
    const instructions = await service.forItem({ agentId, item, workspaceDir });
    assert.match(instructions, /could not be resolved/u);
    assert.match(instructions, /do not infer recipients/u);
  });

  it('should reject an item detached from its admitted assignment event', async () => {
    const item = { ...approvedNotificationItem(), assignmentEventNodeId: 'EV_other' };
    const { service } = guidance({ item });
    assert.match(await service.forItem({ agentId, item, workspaceDir }), /could not be resolved/u);
  });

  it('should reject a manifest from another workspace', async () => {
    const { item, service } = guidance({ workspaceDir: '/workspace/other' });
    assert.match(await service.forItem({ agentId, item, workspaceDir }), /could not be resolved/u);
  });
});
