import assert from 'node:assert/strict';

import createGitHubNotificationMessageAdapter from '../channels/github/publication/message-adapter.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

describe('channels/github/publication/message-adapter', () => {
  it('should reconcile an assignment response using its target intent', async () => {
    const item = notificationMonitorState().items[notificationItemKey]!;
    const target = githubNotificationPublicationTarget({
      intent: 'assignment-response',
      item,
      publicationId: item.intake!.assignmentEventId,
    });
    const calls: unknown[] = [];
    const adapter = createGitHubNotificationMessageAdapter({
      publications: {
        async publish() {
          throw new Error('not used');
        },
        async reconcile(input) {
          calls.push(input);
          return undefined;
        },
      },
    });

    const result = await adapter.durableFinal.reconcileUnknownSend({
      accountId: 'tanaabot',
      cfg: {},
      channel: githubNotificationChannelId,
      enqueuedAt: 1,
      payloads: [{ text: 'I found the user-facing failure and have a focused plan.' }],
      queueId: 'queue-1',
      retryCount: 1,
      to: target,
    });

    assert.deepEqual(result, { status: 'not_sent' });
    assert.deepEqual(calls, [
      {
        accountId: 'tanaabot',
        target,
        text: 'I found the user-facing failure and have a focused plan.',
      },
    ]);
  });

  it('should reject reply-only syntax for an assignment response', async () => {
    const item = notificationMonitorState().items[notificationItemKey]!;
    const target = githubNotificationPublicationTarget({
      intent: 'assignment-response',
      item,
      publicationId: item.intake!.assignmentEventId,
    });
    const adapter = createGitHubNotificationMessageAdapter({
      publications: {
        async publish() {
          throw new Error('not used');
        },
        async reconcile() {
          throw new Error('unsafe text must not reach publication reconciliation');
        },
      },
    });

    await assert.rejects(
      adapter.durableFinal.reconcileUnknownSend({
        accountId: 'tanaabot',
        cfg: {},
        channel: githubNotificationChannelId,
        enqueuedAt: 1,
        payloads: [{ text: '{{commenter}} I have a plan.' }],
        queueId: 'queue-1',
        retryCount: 1,
        to: target,
      }),
      /safe to publish/u,
    );
  });
});
