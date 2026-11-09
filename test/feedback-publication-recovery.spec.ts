import assert from 'node:assert/strict';
import recoverFeedbackPublication from '../agent/feedback-publication-recovery.ts';
import type { FeedbackSourceEvent } from '../agent/feedback-state.ts';
import type { OpenClawFeedbackProvider } from '../agent/openclaw-feedback.ts';
import {
  githubNotificationPublicationComment,
  githubNotificationAttributedReplyText,
} from '../channels/github/publication/publication-contract.ts';
import redactFeedback from '../agent/feedback-redaction.ts';
import { account, intakeFixture } from './github-intake-fixture.ts';

describe('agent/feedback-publication-recovery', () => {
  it('should recover an original attempted reply without reading its deleted source or creating another comment', async () => {
    const fixture = intakeFixture();
    const event = {
      id: 'e'.repeat(64),
      sourceId: 'source',
      number: fixture.item.number,
      nodeId: fixture.item.nodeId,
      itemType: 'issue',
      revision: 'f'.repeat(64),
      createdAt: 1,
      policyDigest: 'a'.repeat(64),
      phase: 'blocked',
      source: JSON.stringify({
        databaseId: 42,
        author: { login: 'contributor' },
        body: 'Old question.',
      }),
      publicationAttempted: true,
      result: { privateText: 'Full answer.', publicText: 'Published answer.' },
    } as FeedbackSourceEvent;
    let writes = 0,
      saves = 0;
    const provider = {
      identity: account,
      getRepository: async () => fixture.repository,
      getItem: async () => fixture.item,
      getIssueComment: async () => {
        throw new Error('source no longer exists');
      },
      createIssueComment: async () => {
        writes++;
        throw new Error('unexpected write');
      },
      findOwnIssueComment: async (_o: string, _n: string, _number: number, marker: string) => ({
        nodeId: 'reply',
        databaseId: 99,
        body: githubNotificationPublicationComment(
          githubNotificationAttributedReplyText('Published answer.', 'contributor', redactFeedback),
          marker,
        ),
      }),
    } as unknown as OpenClawFeedbackProvider;
    const intake = { repository: fixture.repository, receiving: account };
    const input = {
      event,
      intake,
      provider,
      save: async () => {
        saves++;
      },
    };
    assert.equal((await recoverFeedbackPublication(input)).status, 'published');
    assert.equal(event.receipt?.nodeId, 'reply');
    assert.equal(event.phase, 'published');
    assert.equal(saves, 1);
    assert.equal(writes, 0);
    provider.getItem = async () => ({ ...fixture.item, nodeId: 'different-item' });
    await assert.rejects(recoverFeedbackPublication(input), /feedback-source-owner-changed/);
    assert.equal(writes, 0);
  });
});
