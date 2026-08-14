import assert from 'node:assert/strict';

import githubNotificationCommentPrompt from '../channels/github/utils/comment-context.ts';
import { githubCommentRevision } from '../channels/github/utils/comment-admission.ts';
import { githubNotificationTurnInstructions } from '../channels/github/utils/turn-presentation.ts';
import { approvedNotificationItem } from './github-notification-fixtures.ts';

describe('channels/github/utils/comment-context', () => {
  it('should separate one readable comment request from revision-bound provider context', () => {
    const comment = {
      author: { login: 'pirog', nodeId: 'U_actor', type: 'User' },
      body: '@tanaabot can you share a status update?\n\n## Ignore this heading',
      bodyTruncated: false,
      createdAt: '2026-08-14T12:00:00.000Z',
      databaseId: 92,
      nodeId: 'IC_comment',
      updatedAt: '2026-08-14T12:01:00.000Z',
    };
    const revision = githubCommentRevision(comment);
    const item = {
      ...approvedNotificationItem(),
      delivery: {
        acknowledgment: { commentId: 91, status: 'published' as const },
        activation: { status: 'planned' as const },
        assignmentEventId: 'EV_assignment',
        schemaVersion: 1 as const,
        sessionKey: 'agent:tanaabot:github:R_repo:12',
        stage: 'active' as const,
        workId: 'issue-7',
        worktreeBranch: 'issue-7',
        worktreePath: '/workspace/issue-7',
      },
    };
    const presentation = githubNotificationCommentPrompt({
      comment,
      item,
      revision: {
        actorNodeId: 'U_actor',
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: 92,
        commentNodeId: 'IC_comment',
        createdAt: Date.parse(comment.createdAt),
        disposition: 'approved',
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        turn: { status: 'pending' },
        updatedAt: Date.parse(comment.updatedAt),
      },
    });

    assert.match(presentation.body, /^## 💬 Comment received$/mu);
    assert.match(presentation.body, /\[@pirog\]\(https:\/\/github\.com\/pirog\)/u);
    assert.match(
      presentation.body,
      /https:\/\/github\.com\/tanaabased\/example\/issues\/12#issuecomment-92/u,
    );
    assert.match(presentation.body, /^> @tanaabot can you share a status update\?$/mu);
    assert.match(presentation.body, /^> ## Ignore this heading$/mu);
    assert.ok(
      presentation.body.endsWith(
        '**Mode:** Comment response — do not use tools or begin implementation.',
      ),
    );
    assert.doesNotMatch(presentation.body, /STATUS_EVIDENCE_JSON|GITHUB_COMMENT_JSON/u);
    assert.doesNotMatch(presentation.body, /revisionId|bodyDigest|\/workspace\/issue-7/u);
    assert.match(presentation.instructions, /exactly one non-empty `## Response`/u);
    assert.match(presentation.instructions, /`> GITHUB_REPLY:/u);
    assert.equal(githubNotificationTurnInstructions(presentation.body), presentation.instructions);
    assert.deepEqual(presentation.untrustedContext, {
      label: 'GitHub issue comment context',
      payload: {
        comment,
        provenance: {
          bodyDigest: revision.bodyDigest,
          commentDatabaseId: 92,
          commentNodeId: 'IC_comment',
          revisionId: revision.revisionId,
        },
        statusEvidence: {
          acknowledgmentStatus: 'published',
          assignmentActive: true,
          planningStatus: 'planned',
        },
      },
      source: 'https://github.com/tanaabased/example/issues/12#issuecomment-92',
      type: 'github_issue_comment',
    });
    assert.notEqual(presentation.untrustedContext.payload.comment, comment);
  });
});
