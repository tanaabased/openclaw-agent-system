import assert from 'node:assert/strict';

import type { GitHubNotificationsConfiguration } from '../channels/github/config-schema.ts';
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
  maxConcurrentIssues: 2,
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
  it('should separate feedback authors from assigners with independent legacy fallback', () => {
    const cases: Array<{
      configuration: Partial<GitHubNotificationsConfiguration>;
      approved: boolean;
    }> = [
      { configuration: { approvedActors: [notificationActor] }, approved: true },
      { configuration: { approvedFeedbackAuthors: [notificationActor] }, approved: true },
      { configuration: { approvedIssueAssigners: [notificationActor] }, approved: false },
      { configuration: {}, approved: false },
      {
        configuration: { approvedActors: [notificationActor], approvedIssueAssigners: [] },
        approved: true,
      },
      {
        configuration: { approvedActors: [notificationActor], approvedFeedbackAuthors: [] },
        approved: false,
      },
      {
        configuration: {
          approvedActors: [notificationActor],
          approvedFeedbackAuthors: [notificationAccount],
        },
        approved: false,
      },
      {
        configuration: {
          approvedActors: [notificationAccount],
          approvedFeedbackAuthors: [notificationActor],
          approvedIssueAssigners: [],
        },
        approved: true,
      },
    ];
    const settings = { ...configuration, approvedActors: undefined };
    for (const entry of cases) {
      const result = admitGitHubComment({
        account: notificationAccount,
        comment: comment('@tanaabot continue'),
        configuration: { ...settings, ...entry.configuration },
      });
      assert.equal(result.disposition, entry.approved ? 'approved' : 'rejected');
      if (!entry.approved) assert.equal(result.code, 'comment-actor-unapproved');
    }
  });

  it('should retain exact-mention, human-author, self-rejection, and immutable-pin checks for explicit authors', () => {
    for (const entry of [
      {
        body: '@tanaabot-extra continue',
        author: notificationActor,
        code: 'comment-mention-missing',
      },
      {
        body: '> @tanaabot continue',
        author: notificationActor,
        code: 'comment-mention-quote-only',
      },
      { body: '@tanaabot continue', author: notificationAccount, code: 'comment-actor-self' },
      {
        body: '@tanaabot continue',
        author: { ...notificationActor, type: 'Bot' },
        code: 'comment-actor-unsupported',
      },
      {
        body: '@tanaabot continue',
        author: { ...notificationActor, nodeId: 'U_recycled_login' },
        code: 'comment-actor-unapproved',
      },
    ]) {
      assert.equal(
        admitGitHubComment({
          account: notificationAccount,
          comment: comment(entry.body, { author: entry.author }),
          configuration: {
            ...configuration,
            approvedFeedbackAuthors: [notificationActor, notificationAccount],
          },
        }).code,
        entry.code,
      );
    }
  });

  it('should admit an approved human exact standalone account mention', () => {
    const body = 'Could you check this, @Tanaabot?';
    const start = body.indexOf('@Tanaabot');
    assert.deepEqual(
      admitGitHubComment({
        account: notificationAccount,
        comment: comment(body),
        configuration,
      }),
      {
        code: 'comment-approved',
        disposition: 'approved',
        mentions: [{ end: start + '@Tanaabot'.length, start }],
      },
    );
  });

  it('should retain exact source ranges for each admitted prose mention', () => {
    const body = [
      '👋 @Tanaabot could you compare this with `@tanaabot`?',
      '> @tanaabot quoted reply',
      'Then let @TANAABOT know.',
    ].join('\n');
    const result = admitGitHubComment({
      account: notificationAccount,
      comment: comment(body),
      configuration,
    });

    assert.equal(result.disposition, 'approved');
    if (result.disposition !== 'approved') return;
    assert.deepEqual(
      result.mentions.map(({ end, start }) => body.slice(start, end)),
      ['@Tanaabot', '@TANAABOT'],
    );
    assert.deepEqual(result.mentions, [
      {
        end: body.indexOf('@Tanaabot') + '@Tanaabot'.length,
        start: body.indexOf('@Tanaabot'),
      },
      {
        end: body.indexOf('@TANAABOT') + '@TANAABOT'.length,
        start: body.indexOf('@TANAABOT'),
      },
    ]);
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

  it('should apply the effective intake boundary during admission', () => {
    const exact = comment('@tanaabot');
    assert.equal(
      admitGitHubComment({
        account: notificationAccount,
        comment: exact,
        configuration,
        maximumCommentCharacters: exact.body.length,
      }).code,
      'comment-approved',
    );
    assert.equal(
      admitGitHubComment({
        account: notificationAccount,
        comment: exact,
        configuration,
        maximumCommentCharacters: exact.body.length - 1,
      }).code,
      'comment-body-truncated',
    );
  });
});
