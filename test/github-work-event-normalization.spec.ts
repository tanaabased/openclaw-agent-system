import assert from 'node:assert/strict';

import {
  githubResponseIssueComment,
  githubResponseNodeId,
  maximumCommentBodyLength,
} from '../channels/github/provider/work-event-normalization.ts';

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
    const body = 'a'.repeat(maximumCommentBodyLength + 1);

    const normalized = githubResponseIssueComment(
      comment({ body, bodyLength: maximumCommentBodyLength + 1 }),
    );

    assert.equal(normalized.body, 'a'.repeat(maximumCommentBodyLength));
    assert.equal(normalized.bodyTruncated, true);
  });

  it('should reject node ids containing whitespace or control characters', () => {
    assert.throws(() => githubResponseNodeId('IC invalid', 'comment node id'));
    assert.throws(() => githubResponseNodeId('IC_invalid\0', 'comment node id'));
  });
});
