import assert from 'node:assert/strict';

import type { GitHubNotificationsConfiguration } from '../channels/github/config-schema.ts';
import { admitGitHubAssignment } from '../channels/github/intake/admit-assignment.ts';
import {
  notificationAccount as account,
  notificationActor as actor,
  notificationOwner as owner,
  notificationRepository,
} from './github-notification-fixtures.ts';

const event = {
  actor,
  assignee: account,
  createdAt: '2026-08-11T12:05:00.000Z',
  databaseId: 8,
  event: 'assigned' as const,
  nodeId: 'EV_assign',
};
const base = {
  account,
  baselineAt: Date.parse('2026-08-11T12:00:00.000Z'),
  configuration: {
    assignmentTypes: ['issue', 'pull-request'] as Array<'issue' | 'pull-request'>,
    approvedActors: [{ login: actor.login, nodeId: actor.nodeId }],
    allowedRepositoryOwners: [{ login: owner.login, nodeId: owner.nodeId }],
    intervalMinutes: 5,
    maxConcurrentIssues: 2,
  },
  events: [event],
  item: {
    assignees: [account],
    databaseId: 7,
    itemType: 'issue' as const,
    nodeId: 'I_item',
    number: 7,
    state: 'open' as const,
    updatedAt: '2026-08-11T12:05:00.000Z',
  },
  permission: 'write' as const,
  processedEventNodeIds: new Set<string>(),
  repository: {
    ...notificationRepository,
    databaseId: 4,
  },
};

describe('channels/github/intake/admit-assignment', () => {
  it('should separate issue assigners from feedback with independent legacy fallback', () => {
    const cases: Array<{
      configuration: Partial<GitHubNotificationsConfiguration>;
      approved: boolean;
    }> = [
      { configuration: { approvedActors: [actor] }, approved: true },
      { configuration: { approvedIssueAssigners: [actor] }, approved: true },
      { configuration: { approvedFeedbackAuthors: [actor] }, approved: false },
      { configuration: {}, approved: false },
      { configuration: { approvedActors: [actor], approvedFeedbackAuthors: [] }, approved: true },
      { configuration: { approvedActors: [actor], approvedIssueAssigners: [] }, approved: false },
      {
        configuration: { approvedActors: [actor], approvedIssueAssigners: [account] },
        approved: false,
      },
      {
        configuration: {
          approvedActors: [account],
          approvedIssueAssigners: [actor],
          approvedFeedbackAuthors: [],
        },
        approved: true,
      },
    ];
    for (const entry of cases) {
      const settings = { ...base.configuration, approvedActors: undefined };
      const result = admitGitHubAssignment({
        ...base,
        configuration: { ...settings, ...entry.configuration },
      });
      assert.equal(result.disposition, entry.approved ? 'approved' : 'rejected');
      if (!entry.approved) assert.equal(result.code, 'assignment-actor-unapproved');
    }
  });

  it('should preserve direct pull request assignment only through legacy authority', () => {
    const settings = { ...base.configuration, approvedActors: undefined };
    for (const approvedIssueAssigners of [undefined, [], [account], [actor]]) {
      for (const approvedActors of [undefined, [actor]]) {
        const result = admitGitHubAssignment({
          ...base,
          item: {
            ...base.item,
            itemType: 'pull-request',
            pullRequest: {
              baseRef: 'main',
              baseRepositoryDatabaseId: 4,
              baseRepositoryNodeId: 'R_repo',
              draft: false,
              headRef: 'feature',
              headRepositoryDatabaseId: 4,
              headRepositoryNodeId: 'R_repo',
              headSha: 'a'.repeat(40),
              merged: false,
            },
          },
          configuration: {
            ...settings,
            approvedActors,
            approvedIssueAssigners,
            approvedFeedbackAuthors: [actor],
          },
        });
        assert.equal(result.disposition, approvedActors ? 'approved' : 'rejected');
      }
    }
  });

  it('should approve a new assignment from a pinned actor in an allowed writable repository', () => {
    assert.deepEqual(admitGitHubAssignment(base), {
      code: 'assignment-approved',
      disposition: 'approved',
      event,
    });
  });

  it('should reject insufficient permission and a disallowed immutable owner', () => {
    assert.equal(
      admitGitHubAssignment({ ...base, permission: 'read' }).code,
      'repository-permission-insufficient',
    );
    assert.equal(
      admitGitHubAssignment({
        ...base,
        repository: { ...base.repository, owner: { ...owner, nodeId: 'O_other' } },
      }).code,
      'repository-owner-disallowed',
    );
  });

  it('should admit a self-authored assignment when the verified self actor is approved', () => {
    assert.deepEqual(
      admitGitHubAssignment({
        ...base,
        configuration: { ...base.configuration, approvedActors: [account] },
        events: [{ ...event, actor: account }],
      }),
      {
        code: 'assignment-approved',
        disposition: 'approved',
        event: { ...event, actor: account },
      },
    );
  });

  it('should reject an unapproved assignment, including an unapproved self actor', () => {
    assert.equal(
      admitGitHubAssignment({
        ...base,
        events: [{ ...event, actor: { ...actor, nodeId: 'U_other' } }],
      }).code,
      'assignment-actor-unapproved',
    );
    assert.equal(
      admitGitHubAssignment({ ...base, events: [{ ...event, actor: account }] }).code,
      'assignment-actor-unapproved',
    );
  });

  it('should reject baseline history and deduplicate a processed immutable event', () => {
    assert.equal(
      admitGitHubAssignment({ ...base, baselineAt: Date.parse(event.createdAt) }).code,
      'assignment-before-baseline',
    );
    assert.deepEqual(
      admitGitHubAssignment({ ...base, processedEventNodeIds: new Set([event.nodeId]) }),
      { code: 'assignment-duplicate', disposition: 'duplicate', event },
    );
  });
});
