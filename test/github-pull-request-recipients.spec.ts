import assert from 'node:assert/strict';

import resolveRecipients from '../channels/github/pull-request-recipients.ts';
import parseAgentManifest from '../manifest/parse.ts';

const actor = { login: 'assigner', nodeId: 'U_actor' };
const pin = { login: 'maintainer', 'node-id': 'U_maintainer', roles: ['assignee', 'reviewer'] };
const parse = (recipients: unknown) =>
  parseAgentManifest(
    JSON.stringify({
      'schema-version': 1,
      agent: { id: 'test' },
      github: {
        username: 'receiver',
        notifications: {
          'schema-version': 2,
          'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
          'issue-assignment': { 'pull-request': { recipients } },
        },
      },
    }),
  );

describe('channels/github/pull-request-recipients', () => {
  it('should distinguish omitted defaults from an explicit empty list and merge roles by identity', () => {
    assert.deepEqual(resolveRecipients(undefined, actor), { assignees: [actor], reviewers: [] });
    assert.deepEqual(resolveRecipients([], actor), { assignees: [], reviewers: [] });
    assert.deepEqual(
      resolveRecipients(
        [
          { source: 'assignment-actor', roles: ['assignee'] },
          { ...actor, login: 'ASSIGNER', roles: ['reviewer'] },
        ],
        actor,
      ),
      { assignees: [actor], reviewers: [actor] },
    );
    assert.throws(() => resolveRecipients(undefined), /assignment actor identity is unavailable/);
    assert.throws(
      () =>
        resolveRecipients(
          [
            { source: 'assignment-actor', roles: ['assignee'] },
            { ...actor, nodeId: 'U_other', roles: ['reviewer'] },
          ],
          actor,
        ),
      /identity-conflict/,
    );
  });
  it('should decode pinned and dynamic recipients without granting feedback authority', () => {
    const parsed = parse([{ source: 'assignment-actor', roles: ['assignee'] }, pin]);
    assert.ok(parsed.status === 'valid');
    const policy = parsed.manifest.github!.notifications;
    assert.ok(policy?.schemaVersion === 2);
    assert.deepEqual(resolveRecipients(policy.issueAssignment!.pullRequest!.recipients, actor), {
      assignees: [actor, { login: 'maintainer', nodeId: 'U_maintainer' }],
      reviewers: [{ login: 'maintainer', nodeId: 'U_maintainer' }],
    });
    assert.equal(policy.issueAssignment!.feedback, undefined);
    assert.deepEqual(policy.issueAssignment!.allowed, []);
  });
  it('should reject conflicting pins, incomplete identities, unknown sources and invalid roles', () => {
    for (const recipients of [
      [pin, { ...pin, 'node-id': 'U_other' }],
      [pin, { ...pin, login: 'renamed' }],
      [{ login: 'missing', roles: ['assignee'] }],
      [{ ...pin, source: 'assignment-actor' }],
      [{ source: 'issue-author', roles: ['assignee'] }],
      [{ ...pin, roles: [] }],
      [{ ...pin, roles: ['assignee', 'assignee'] }],
      [{ ...pin, roles: ['owner'] }],
    ])
      assert.equal(parse(recipients).status, 'invalid', JSON.stringify(recipients));
  });
});
