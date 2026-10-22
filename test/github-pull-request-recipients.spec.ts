import assert from 'node:assert/strict';

import resolveRecipients from '../channels/github/pull-request-recipients.ts';
import parseAgentManifest from '../manifest/parse.ts';

const actor = { login: 'assigner', nodeId: 'U_actor' };
const pin = { name: 'maintainer', 'node-id': 'U_maintainer' };
const parse = (reviewers: unknown) =>
  parseAgentManifest(
    JSON.stringify({
      'schema-version': 1,
      agent: { id: 'test' },
      github: {
        username: 'receiver',
        'schema-version': 3,
        'allowed-repository-owners': [{ org: 'owner', 'node-id': 'O_owner' }],
        'issue-assignment': { reviewers },
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
  it('should keep the original actor as assignee and derive reviewer feedback', () => {
    const parsed = parse([pin]);
    assert.ok(parsed.status === 'valid');
    const policy = parsed.manifest.github!.notifications!;
    assert.equal(policy.schemaVersion, 3);
    assert.deepEqual(resolveRecipients(policy.issueAssignment!.pullRequest!.recipients, actor), {
      assignees: [actor],
      reviewers: [{ login: 'maintainer', nodeId: 'U_maintainer' }],
    });
    assert.deepEqual(policy.issueAssignment!.feedback, {
      inherit: true,
      allowed: [{ login: 'maintainer', nodeId: 'U_maintainer' }],
    });
  });
  it('should reject conflicting pins and removed recipient selectors', () => {
    for (const reviewers of [
      [pin, { ...pin, 'node-id': 'U_other' }],
      [{ name: 'missing' }],
      [{ ...pin, roles: ['assignee'] }],
      [{ source: 'assignment-actor' }],
    ])
      assert.equal(parse(reviewers).status, 'invalid');
  });
});
