import assert from 'node:assert/strict';

import {
  githubResponseIssueComment,
  githubResponseNodeId,
} from '../channels/github/provider/work-event-normalization.ts';
import { defaultMaximumCommentCharacters } from '../channels/github/provider/comment-limit.ts';

function comment(overrides: Record<string, unknown> = {}) {
  return {
    author: null,
    body: 'hello',
    bodyLength: 5,
    createdAt: '2026-08-11T12:00:00Z',
    databaseId: 1,
    nodeId: 'IC_comment',
    updatedAt: '2026-08-11T12:00:00Z',
    ...overrides,
  };
}

describe('channels/github/provider/work-event-normalization', () => {
  it('should preserve a missing comment author while retaining useful control facts', () => {
    assert.deepEqual(githubResponseIssueComment(comment()), {
      author: undefined,
      body: 'hello',
      bodyTruncated: false,
      createdAt: '2026-08-11T12:00:00Z',
      databaseId: 1,
      nodeId: 'IC_comment',
      updatedAt: '2026-08-11T12:00:00Z',
    });
  });

  it('should bound comment prose independently from its reported source length', () => {
    const boundary = githubResponseIssueComment(
      comment({
        body: 'a'.repeat(defaultMaximumCommentCharacters),
        bodyLength: defaultMaximumCommentCharacters,
      }),
    );
    const body = 'a'.repeat(defaultMaximumCommentCharacters + 1);

    const normalized = githubResponseIssueComment(
      comment({ body, bodyLength: defaultMaximumCommentCharacters + 1 }),
    );

    assert.equal(boundary.bodyTruncated, false);
    assert.equal(normalized.body, 'a'.repeat(defaultMaximumCommentCharacters));
    assert.equal(normalized.bodyTruncated, true);
  });

  it('should apply an overridden boundary exactly', () => {
    const complete = githubResponseIssueComment(
      comment({ body: 'a'.repeat(12), bodyLength: 12 }),
      12,
    );
    const oversized = githubResponseIssueComment(
      comment({ body: 'a'.repeat(13), bodyLength: 13 }),
      12,
    );

    assert.equal(complete.body.length, 12);
    assert.equal(complete.bodyTruncated, false);
    assert.equal(oversized.body.length, 12);
    assert.equal(oversized.bodyTruncated, true);
  });

  it('should count unicode code points consistently with the provider projection', () => {
    const normalized = githubResponseIssueComment(comment({ body: '🚀🚀🚀', bodyLength: 3 }), 2);

    assert.equal(normalized.body, '🚀🚀');
    assert.equal(normalized.bodyTruncated, true);
  });

  it('should reject node ids containing whitespace or control characters', () => {
    assert.throws(() => githubResponseNodeId('IC invalid', 'comment node id'));
    assert.throws(() => githubResponseNodeId('IC_invalid\0', 'comment node id'));
  });
});
