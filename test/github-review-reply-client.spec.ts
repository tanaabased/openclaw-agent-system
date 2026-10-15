import assert from 'node:assert/strict';

import GitHubReviewReplyClient from '../channels/github/provider/review-reply-client.ts';
import type GitHubReviewClient from '../channels/github/provider/review-client.ts';
import type GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import {
  reviewFixture,
  reviewCommentFixture,
  reviewClientFixture,
} from './github-review-fixtures.ts';

describe('channels/github/provider/review-reply-client', () => {
  it('should publish to the retained root and verify provider identity and body', async () => {
    const reply = reviewCommentFixture({ replyToId: 42, body: 'An answer.' });
    const calls: unknown[] = [];
    const api = {
      identity: reply.author,
      request: async (argv: string[], _label: string, stdin: string) => {
        calls.push({ argv, stdin });
        return { value: reply.databaseId };
      },
    } as unknown as GitHubWorkEventApiClient;
    const reviews = reviewClientFixture(reviewFixture(), [reply]) as GitHubReviewClient;
    const client = new GitHubReviewReplyClient(api, reviews);
    assert.equal((await client.create('owner', 'repo', 9, 42, reply.body)).nodeId, reply.nodeId);
    assert.deepEqual(calls, [
      {
        argv: [
          '--method',
          'POST',
          '/repos/owner/repo/pulls/9/comments/42/replies',
          '--input',
          '-',
          '--jq',
          '.id',
        ],
        stdin: JSON.stringify({ body: reply.body }),
      },
    ]);
    reply.replyToId = 41;
    await assert.rejects(client.create('owner', 'repo', 9, 42, reply.body), /receipt-invalid/);
  });
  it('should ignore foreign copied markers and reject duplicate receipts across pages', async () => {
    const own = reviewCommentFixture({ replyToId: 42, body: 'marker' });
    const foreign = { ...own, author: { ...own.author!, nodeId: 'foreign' } };
    const api = { identity: own.author } as GitHubWorkEventApiClient;
    const reviews = reviewClientFixture(reviewFixture(), []) as GitHubReviewClient;
    reviews.listComments = async (_o, _n, _number, page) => ({
      values: page === 1 ? [foreign] : [own],
      nextPage: page === 1 ? 2 : 1,
    });
    const client = new GitHubReviewReplyClient(api, reviews);
    assert.equal((await client.find('owner', 'repo', 9, 42, 'marker'))?.nodeId, own.nodeId);
    reviews.listComments = async (_o, _n, _number, page) => ({
      values: [own],
      nextPage: page === 1 ? 2 : 1,
    });
    await assert.rejects(client.find('owner', 'repo', 9, 42, 'marker'), /publication-ambiguous/);
  });
});
