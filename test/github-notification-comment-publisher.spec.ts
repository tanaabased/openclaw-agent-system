import assert from 'node:assert/strict';

import GitHubNotificationCommentPublisher from '../channels/github/lib/comment-publisher.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

function input() {
  return {
    intent: 'github-reply' as const,
    item: approvedNotificationItem(),
    source: { commentDatabaseId: 89, revisionId: 'a'.repeat(64) },
    text: 'I checked this and the current behavior is understood.',
  };
}

describe('channels/github/lib/comment-publisher', () => {
  it('should reauthorize before connecting and publish one marked comment', async () => {
    const calls: string[] = [];
    let publishedBody = '';
    const publisher = new GitHubNotificationCommentPublisher({
      authorize({ target }) {
        calls.push(`authorize:${target}`);
        return { authorized: true };
      },
      connect() {
        calls.push('connect');
        return {
          async findOwnIssueComment(_owner, _name, _number, marker) {
            calls.push(`find:${marker}`);
            return undefined;
          },
          async createIssueComment(_owner, _name, _number, body) {
            calls.push('create');
            publishedBody = body;
            return { databaseId: 91, nodeId: 'IC_published' };
          },
        };
      },
      async exclusive(key, run) {
        calls.push(`exclusive:${key}`);
        return run();
      },
    });

    const result = await publisher.publish(input());

    assert.equal(result.status, 'published');
    assert.deepEqual(result.receipt, { databaseId: 91, nodeId: 'IC_published' });
    assert.match(publishedBody, /^I checked this/u);
    assert.match(publishedBody, /<!-- agent-system-github-publication:github-reply:/u);
    assert.match(calls[0] ?? '', /^exclusive:/u);
    assert.match(calls[1] ?? '', /^authorize:/u);
    assert.equal(calls[2], 'connect');
  });

  it('should reconcile an existing marker without creating another comment', async () => {
    let created = false;
    const publisher = new GitHubNotificationCommentPublisher({
      authorize: () => ({ authorized: true }),
      connect: () => ({
        findOwnIssueComment: async (_owner, _name, _number, marker) => ({
          body: `I checked this and the current behavior is understood.\n\n${marker}`,
          databaseId: 90,
          nodeId: 'IC_existing',
        }),
        createIssueComment: async () => {
          created = true;
          return { databaseId: 91, nodeId: 'IC_created' };
        },
      }),
      exclusive: async (_key, run) => run(),
    });

    const result = await publisher.publish(input());

    assert.equal(result.status, 'reconciled');
    assert.equal(result.receipt.nodeId, 'IC_existing');
    assert.equal(created, false);
  });

  it('should reject an existing marker whose accepted body differs', async () => {
    let created = false;
    const publisher = new GitHubNotificationCommentPublisher({
      authorize: () => ({ authorized: true }),
      connect: () => ({
        findOwnIssueComment: async () => ({
          body: 'Different accepted text.',
          databaseId: 90,
          nodeId: 'IC_existing',
        }),
        createIssueComment: async () => {
          created = true;
          return { databaseId: 91, nodeId: 'IC_created' };
        },
      }),
      exclusive: async (_key, run) => run(),
    });

    await assert.rejects(publisher.publish(input()), (error: unknown) => {
      return (
        error instanceof Error &&
        'code' in error &&
        error.code === 'github-notification-publication-reconciliation-conflict'
      );
    });
    assert.equal(created, false);
  });

  it('should reject revoked authority before credentials are connected', async () => {
    let connected = false;
    const publisher = new GitHubNotificationCommentPublisher({
      authorize: () => ({ authorized: false, reasonCode: 'authority-revoked' }),
      connect: () => {
        connected = true;
        throw new Error('must not connect');
      },
      exclusive: async (_key, run) => run(),
    });

    await assert.rejects(publisher.publish(input()), (error: unknown) => {
      return error instanceof Error && 'code' in error && error.code === 'authority-revoked';
    });
    assert.equal(connected, false);
  });
});
