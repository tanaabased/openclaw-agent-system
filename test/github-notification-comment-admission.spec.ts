import assert from 'node:assert/strict';

import {
  admitGitHubComment,
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
} from '../channels/github/conversation/comment-admission.ts';
import { notificationAccount, notificationActor } from './github-notification-fixtures.ts';

const configuration = {
  assignmentTypes: ['issue', 'pull-request'] as Array<'issue' | 'pull-request'>,
  approvedActors: [{ login: notificationActor.login, nodeId: notificationActor.nodeId }],
  intervalMinutes: 5,
};

function comment(
  body: string,
  overrides: Partial<GitHubCanonicalIssueComment> = {},
): GitHubCanonicalIssueComment {
  return {
    author: notificationActor,
    body,
    bodyTruncated: false,
    createdAt: '2026-08-14T12:00:00.000Z',
    databaseId: 91,
    nodeId: 'IC_comment',
    updatedAt: '2026-08-14T12:00:00.000Z',
    ...overrides,
  };
}

describe('channels/github/conversation/comment-admission', () => {
  it('should admit an approved human exact standalone account mention', () => {
    assert.deepEqual(
      admitGitHubComment({
        account: notificationAccount,
        comment: comment('Could you check this, @Tanaabot?'),
        configuration,
      }),
      { code: 'comment-approved', disposition: 'approved' },
    );
  });

  it('should reject literal agent, partial, self, bot, and unapproved mentions', () => {
    const cases = [
      { body: '@agent please check', code: 'comment-mention-missing' },
      { body: '@tanaabot-extra please check', code: 'comment-mention-missing' },
      {
        body: '@tanaabot please check',
        code: 'comment-actor-self',
        overrides: { author: notificationAccount },
      },
      {
        body: '@tanaabot please check',
        code: 'comment-actor-unsupported',
        overrides: { author: { ...notificationActor, type: 'Bot' } },
      },
      {
        body: '@tanaabot please check',
        code: 'comment-actor-unapproved',
        overrides: { author: { ...notificationActor, nodeId: 'U_other' } },
      },
    ];
    for (const entry of cases) {
      assert.equal(
        admitGitHubComment({
          account: notificationAccount,
          comment: comment(entry.body, entry.overrides),
          configuration,
        }).code,
        entry.code,
      );
    }
  });

  it('should reject mentions that exist only in quotes, code, or generated markers', () => {
    const bodies = [
      '> @tanaabot please check',
      '- > @tanaabot nested quote',
      '    @tanaabot indented code',
      '```text\n@tanaabot please check\n```',
      'The literal `@tanaabot` is an example.',
      'The literal <code>@tanaabot</code> is an example.',
      '<blockquote>@tanaabot quoted reply</blockquote>',
      '<!-- @tanaabot generated marker -->',
      'See [the profile](https://github.com/@tanaabot).',
    ];
    for (const body of bodies) {
      assert.equal(
        admitGitHubComment({
          account: notificationAccount,
          comment: comment(body),
          configuration,
        }).code,
        'comment-mention-quote-only',
      );
    }
  });

  it('should reject incomplete prose and derive a new revision after an edit', () => {
    const first = comment('@tanaabot status?', { bodyTruncated: true });
    assert.equal(
      admitGitHubComment({ account: notificationAccount, comment: first, configuration }).code,
      'comment-body-truncated',
    );
    const edited = comment('@tanaabot status please', {
      updatedAt: '2026-08-14T12:01:00.000Z',
    });
    assert.notEqual(
      githubCommentRevision(first).revisionId,
      githubCommentRevision(edited).revisionId,
    );
  });
});
