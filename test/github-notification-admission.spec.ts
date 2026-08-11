import assert from 'node:assert/strict';

import { admitGitHubAssignment } from '../channels/github/utils/admit-assignment.ts';

const account = { login: 'tanaabot', nodeId: 'U_agent', type: 'User' };
const actor = { login: 'pirog', nodeId: 'U_actor', type: 'User' };
const owner = { login: 'tanaabased', nodeId: 'O_owner', type: 'Organization' };
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
    approvedActors: [{ login: actor.login, nodeId: actor.nodeId }],
    intervalMinutes: 5,
    repositoryPolicy: {
      allowedOwners: [{ login: owner.login, nodeId: owner.nodeId }],
      minimumPermission: 'write' as const,
    },
  },
  events: [event],
  item: {
    assignees: [account],
    itemType: 'issue' as const,
    nodeId: 'I_item',
    number: 7,
    state: 'open' as const,
    updatedAt: '2026-08-11T12:05:00.000Z',
  },
  permission: 'write' as const,
  processedEventNodeIds: new Set<string>(),
  repository: {
    archived: false,
    cloneUrl: 'https://github.com/tanaabased/example.git',
    databaseId: 4,
    defaultBranch: 'main',
    disabled: false,
    name: 'example',
    nodeId: 'R_repo',
    owner,
  },
};

describe('channels/github/utils/admit-assignment', () => {
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

  it('should reject an unapproved or self-authored assignment', () => {
    assert.equal(
      admitGitHubAssignment({
        ...base,
        events: [{ ...event, actor: { ...actor, nodeId: 'U_other' } }],
      }).code,
      'assignment-actor-unapproved',
    );
    assert.equal(
      admitGitHubAssignment({ ...base, events: [{ ...event, actor: account }] }).code,
      'assignment-actor-self',
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
