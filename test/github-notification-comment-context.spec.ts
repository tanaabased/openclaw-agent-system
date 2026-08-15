import assert from 'node:assert/strict';

import { githubCommentRevision } from '../channels/github/utils/comment-admission.ts';
import githubNotificationCommentPrompt from '../channels/github/utils/comment-context.ts';
import { approvedPullRequestNotificationItem } from './github-notification-fixtures.ts';

describe('channels/github/utils/comment-context', () => {
  it('should separate direct comment input from hidden instructions and current-turn evidence', () => {
    const comment = {
      author: { login: 'reviewer_*', nodeId: 'U_reviewer', type: 'User' },
      body: '@tanaabot please summarize the recorded plan.',
      bodyTruncated: false,
      createdAt: '2026-08-14T12:00:00.000Z',
      databaseId: 92,
      nodeId: 'IC_comment',
      updatedAt: '2026-08-14T12:01:00.000Z',
    };
    const revision = githubCommentRevision(comment);
    const item = approvedPullRequestNotificationItem();
    item.delivery = {
      ...item.delivery!,
      activation: { reply: { commentId: 91, status: 'published' }, status: 'planned' },
      sessionKey: 'agent:tanaabot:comment',
      stage: 'active',
    };
    const prompt = githubNotificationCommentPrompt({
      comment,
      item,
      revision: {
        ...revision,
        commentDatabaseId: comment.databaseId,
        commentNodeId: comment.nodeId,
      },
    });

    assert.equal(prompt.body, comment.body);
    assert.match(prompt.instructions, /Return exactly one private Markdown response/u);
    assert.match(prompt.instructions, /## 📤 To GitHub/u);
    assert.doesNotMatch(prompt.instructions, /summarize the recorded plan/u);
    assert.deepEqual(prompt.request, {
      assignmentKind: 'pull-request',
      event: 'comment-received',
      mode: 'plan',
    });
    assert.deepEqual(prompt.untrustedContext, {
      label: 'GitHub pull-request comment context',
      payload: {
        bounds: {
          commentBodyCharacters: comment.body.length,
          commentBodyTruncated: false,
        },
        comment,
        item: {
          itemType: 'pull-request',
          number: 13,
          repositoryName: 'example',
          repositoryOwner: 'tanaabased',
        },
        revision: {
          bodyDigest: revision.bodyDigest,
          id: revision.revisionId,
        },
        statusEvidence: {
          assignmentActive: true,
          planningReplyStatus: 'published',
          planningStatus: 'planned',
        },
      },
      source: 'https://github.com/tanaabased/example/pull/13#issuecomment-92',
      type: 'github_pull_request_comment',
    });
    assert.notEqual(prompt.untrustedContext.payload.comment, comment);
  });

  it('should reject a mismatched admitted revision', () => {
    const comment = {
      author: { login: 'pirog', nodeId: 'U_actor', type: 'User' },
      body: '@tanaabot status?',
      bodyTruncated: false,
      createdAt: '2026-08-14T12:00:00.000Z',
      databaseId: 92,
      nodeId: 'IC_comment',
      updatedAt: '2026-08-14T12:01:00.000Z',
    };
    const revision = githubCommentRevision(comment);

    assert.throws(
      () =>
        githubNotificationCommentPrompt({
          comment,
          item: approvedPullRequestNotificationItem(),
          revision: {
            ...revision,
            commentDatabaseId: 93,
            commentNodeId: comment.nodeId,
          },
        }),
      /must match their admitted comment/u,
    );
  });
});
