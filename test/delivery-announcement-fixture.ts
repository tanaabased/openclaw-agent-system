import assert from 'node:assert/strict';

import type { DeliveryAnnouncementState } from '../agent/delivery-announcement-state.ts';
import {
  githubNotificationPublicationComment,
  githubNotificationPublicationMarker,
  githubNotificationPublicationTarget,
} from '../channels/github/publication/publication-contract.ts';

import type { GitHubIdentity } from '../channels/github/provider/work-item.ts';

/** model the projected provider responses, including response loss after an accepted post. */
export default function announcementFixture(author: GitHubIdentity) {
  const state = {
    draft: false,
    lost: false,
    posts: 0,
    comments: [] as Array<{
      nodeId: string;
      databaseId: number;
      body: string;
      user: GitHubIdentity;
    }>,
    execute(argv: readonly string[], stdin?: string) {
      if (!argv.includes('/repos/owner/repo/issues/3/comments')) return undefined;
      assert.ok(argv.includes('--include'));
      let value: unknown = state.comments;
      if (argv.includes('POST')) {
        state.posts++;
        const comment = {
          nodeId: 'IC_announcement',
          databaseId: 91,
          body: JSON.parse(stdin!).body as string,
          user: { ...author, type: author.type ?? 'User' },
        };
        state.comments.push(comment);
        if (state.lost) throw new Error('response lost');
        value = comment;
      }
      return {
        exitCode: 0,
        stdout: 'HTTP/2.0 200 OK\r\n\r\n' + JSON.stringify(value),
        stderr: '',
        timedOut: false,
        truncated: false,
      };
    },
  };
  return state;
}

/** represent an accepted comment whose post response was lost before receipt storage. */
export function attemptedAnnouncement(authorId: string) {
  const state: DeliveryAnnouncementState = {
    publicationId: 'a'.repeat(64),
    authorId,
    attempted: true,
    snapshot: {
      pullRequestNodeId: 'PR_7',
      pullRequestNumber: 7,
      draft: false,
      head: 'a'.repeat(40),
      title: 'Title',
      body: 'Body',
    },
    composition: {
      version: 1,
      observedAt: 1,
      requestedSkill: 'reply',
      defaultSkill: true,
      skill: {
        name: 'reply',
        path: '/skills/reply/SKILL.md',
        scope: 'user',
        digest: 'a'.repeat(64),
      },
    },
    publicText:
      '@receiver the requested change is ready. [PR #7](https://github.com/owner/repo/pull/7) — Ready for review.',
  };
  const target = githubNotificationPublicationTarget({
    intent: 'pull-request-handoff',
    publicationId: state.publicationId,
    item: {
      lifecycleId: 'issue',
      number: 3,
      repositoryNodeId: 'R_repo',
    },
  });
  return {
    state,
    body: githubNotificationPublicationComment(
      state.publicText!,
      githubNotificationPublicationMarker(target),
    ),
  };
}
