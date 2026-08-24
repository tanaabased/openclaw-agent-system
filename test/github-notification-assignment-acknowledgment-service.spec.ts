import assert from 'node:assert/strict';

import GitHubNotificationAssignmentAcknowledgmentService from '../channels/github/conversation/assignment-acknowledgment-service.ts';
import type { GitHubNotificationConversationState } from '../channels/github/conversation/conversation-state.ts';
import { parseGitHubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

function memoryStateStore() {
  let state: GitHubNotificationConversationState | undefined;
  return {
    async read() {
      return state === undefined ? undefined : structuredClone(state);
    },
    snapshot() {
      return state === undefined ? undefined : structuredClone(state);
    },
    async write(next: GitHubNotificationConversationState) {
      state = structuredClone(next);
    },
  };
}

describe('channels/github/conversation/assignment-acknowledgment-service', () => {
  it('should checkpoint accepted text before publishing and retain one receipt', async () => {
    const store = memoryStateStore();
    const publications: Array<{ target: string; text: string }> = [];
    const service = new GitHubNotificationAssignmentAcknowledgmentService({
      conversationStateStore: store,
      publications: {
        async publish({ target, text }) {
          publications.push({ target, text });
          const conversation = Object.values(store.snapshot()?.conversations ?? {})[0];
          assert.equal(conversation?.acknowledgment?.status, 'pending');
          return {
            receipt: { databaseId: 101, nodeId: 'IC_acknowledgment' },
            status: 'published',
            target,
          };
        },
      },
    });
    const input = {
      agentId: 'tanaabot',
      item: approvedNotificationItem(),
      modeId: 'work' as const,
      workspaceDir: '/workspace',
    };

    await service.publish(input);
    await service.publish(input);

    assert.equal(publications.length, 1);
    assert.equal(
      parseGitHubNotificationPublicationTarget(publications[0]!.target).intent,
      'initial-acknowledgment',
    );
    assert.ok(publications[0]!.text.length > 0);
    const conversation = Object.values(store.snapshot()?.conversations ?? {})[0];
    assert.equal(conversation?.baselineEstablished, false);
    assert.deepEqual(conversation?.acknowledgment, {
      commentDatabaseId: 101,
      commentNodeId: 'IC_acknowledgment',
      publicText: publications[0]!.text,
      publicTextDigest: conversation?.acknowledgment?.publicTextDigest,
      status: 'published',
      target: publications[0]!.target,
    });
  });

  it('should retry the same checkpointed acknowledgment without regeneration', async () => {
    const store = memoryStateStore();
    const publishedTexts: string[] = [];
    let attempts = 0;
    const service = new GitHubNotificationAssignmentAcknowledgmentService({
      conversationStateStore: store,
      publications: {
        async publish({ target, text }) {
          attempts += 1;
          publishedTexts.push(text);
          if (attempts === 1) throw new Error('unknown send result');
          return {
            receipt: { databaseId: 101, nodeId: 'IC_acknowledgment' },
            status: 'reconciled',
            target,
          };
        },
      },
    });
    const input = {
      agentId: 'tanaabot',
      item: approvedNotificationItem(),
      modeId: 'work' as const,
      workspaceDir: '/workspace',
    };

    await assert.rejects(service.publish(input), /unknown send result/u);
    await service.publish(input);

    assert.equal(attempts, 2);
    assert.equal(publishedTexts[0], publishedTexts[1]);
    const conversation = Object.values(store.snapshot()?.conversations ?? {})[0];
    assert.equal(conversation?.acknowledgment?.status, 'published');
  });
});
