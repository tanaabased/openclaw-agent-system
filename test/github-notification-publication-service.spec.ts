import assert from 'node:assert/strict';

import GitHubNotificationPublicationService from '../channels/github/lib/publication-service.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

describe('channels/github/lib/publication-service', () => {
  it('should route one explicit final reply through required durable delivery', async () => {
    let delivered: Record<string, unknown> | undefined;
    const service = new GitHubNotificationPublicationService({
      async deliver(input) {
        delivered = input as unknown as Record<string, unknown>;
        return {
          delivery: { visibleReplySent: true },
          status: 'handled_visible',
        };
      },
    });

    const result = await service.publish({
      accountId: 'tanaabot',
      agentId: 'tanaabot',
      cfg: {},
      ctxPayload: {} as never,
      info: { kind: 'final' },
      intent: 'initial-acknowledgment',
      item: approvedNotificationItem(),
      payload: { text: 'I have this one.' },
      publicationId: 'EV_assignment',
    });

    assert.equal(result.status, 'handled_visible');
    assert.equal(delivered?.channel, 'agent-system-github');
    assert.deepEqual(delivered?.requiredCapabilities, {
      reconcileUnknownSend: true,
      text: true,
    });
    assert.match(String(delivered?.to), /:publication:initial-acknowledgment:/u);
    assert.deepEqual(delivered?.payload, { text: 'I have this one.' });
  });

  it('should reject unsafe content before durable delivery', async () => {
    let deliveries = 0;
    const service = new GitHubNotificationPublicationService({
      async deliver() {
        deliveries += 1;
        return { reason: 'non_final', status: 'not_applicable' };
      },
    });

    await assert.rejects(
      service.publish({
        accountId: 'tanaabot',
        agentId: 'tanaabot',
        cfg: {},
        ctxPayload: {} as never,
        info: { kind: 'final' },
        intent: 'github-reply',
        item: approvedNotificationItem(),
        payload: { text: 'Read /Users/pirog/secret.txt' },
        publicationId: 'comment-1',
      }),
      /not safe to publish/u,
    );
    assert.equal(deliveries, 0);
  });
});
