import assert from 'node:assert/strict';

import { stringify } from 'yaml';

import { legacyGitHubNotifications } from '../channels/github/config-schema.ts';
import { githubNotificationRuntimeBlocker } from '../channels/github/notification-policy.ts';
import parseAgentManifest from '../manifest/parse.ts';

const actor = { login: 'pirog', 'node-id': 'MDQ6VXNlcjcxMzQyNA==' };
const owner = { login: 'tanaabased', 'node-id': 'O_kgDODNGy1g' };
const policy = { 'schema-version': 2, 'allowed-repository-owners': [owner] };

function parse(notifications: unknown, username: unknown = 'pirog') {
  return parseAgentManifest(
    stringify({
      'schema-version': 1,
      agent: { id: 'pirog' },
      github: { host: 'github.com', username, notifications },
    }),
  );
}

function parsed(notifications: unknown) {
  const result = parse(notifications);
  if (result.status !== 'valid') throw new Error(JSON.stringify(result.diagnostics));
  const declaration = result.manifest.github?.notifications;
  assert.ok(declaration?.schemaVersion === 2);
  return declaration;
}

describe('channels/github/notification-policy', () => {
  it('should decode portable defaults without manufacturing trigger authority', () => {
    assert.deepEqual(parsed(policy), {
      schemaVersion: 2,
      runtimes: ['openclaw', 'codex'],
      intervalMinutes: 5,
      maxConcurrentItems: 2,
      allowedRepositoryOwners: [{ login: owner.login, nodeId: owner['node-id'] }],
    });
    const declaration = parsed({ ...policy, 'issue-assignment': {}, feedback: { allowed: [] } });
    assert.deepEqual(declaration.issueAssignment, { allowed: [], mode: 'plan' });
    assert.deepEqual(declaration.feedback, { allowed: [] });
    assert.equal(declaration.reviewRequest, undefined);
    assert.equal(legacyGitHubNotifications(declaration), undefined);
  });

  it('should preserve independent trigger grants and explicit operator flags in each mode', () => {
    for (const mode of ['plan', 'work', 'auto'] as const) {
      const declaration = parsed({
        ...policy,
        runtimes: ['codex'],
        'interval-minutes': 10,
        'max-concurrent-items': 3,
        'issue-assignment': { allowed: [{ ...actor, 'operator-owner': true }], mode },
        'review-request': { allowed: [] },
        feedback: { allowed: [actor] },
      });
      assert.deepEqual(declaration.issueAssignment, {
        allowed: [{ login: actor.login, nodeId: actor['node-id'], operatorOwner: true }],
        mode,
      });
      assert.deepEqual(declaration.reviewRequest?.allowed, []);
      assert.deepEqual(declaration.feedback?.allowed, [
        { login: actor.login, nodeId: actor['node-id'], operatorOwner: false },
      ]);
      assert.equal(declaration.intervalMinutes, 10);
      assert.equal(declaration.maxConcurrentItems, 3);
      assert.equal(
        githubNotificationRuntimeBlocker(declaration, 'codex')?.code,
        'github-notification-runtime-unsupported',
      );
      assert.equal(githubNotificationRuntimeBlocker(declaration, 'openclaw'), undefined);
    }
  });

  it('should reject legacy mixtures and unsupported customization or mode fields', () => {
    for (const extra of [
      { 'approved-actors': [actor] },
      { 'approved-issue-assigners': [actor] },
      { 'assignment-types': ['issue'] },
      { 'initial-mode': 'work' },
      { 'max-concurrent-issues': 2 },
      { 'pull-request': { reviewers: [actor] } },
      { 'issue-assignment': { mode: 'guided' } },
      { 'issue-assignment': { guidance: 'implement everything' } },
      { 'review-request': { mode: 'work' } },
      { feedback: { mode: 'work' } },
    ])
      assert.equal(parse({ ...policy, ...extra }).status, 'invalid', JSON.stringify(extra));
    assert.equal(parse({ 'issue-assignment': { allowed: [actor] } }).status, 'invalid');
  });

  it('should require bounded cadence, capacity, runtime selection, and explicit repository scope', () => {
    for (const extra of [
      { runtimes: [] },
      { runtimes: ['other'] },
      { runtimes: ['codex', 'codex'] },
      { 'interval-minutes': 0 },
      { 'interval-minutes': 1441 },
      { 'interval-minutes': 1.5 },
      { 'max-concurrent-items': 0 },
      { 'max-concurrent-items': 1.5 },
      { 'allowed-repository-owners': [] },
      { 'allowed-repository-owners': [{ ...owner, 'operator-owner': true }] },
      { 'schema-version': 3 },
    ])
      assert.equal(parse({ ...policy, ...extra }).status, 'invalid', JSON.stringify(extra));
    assert.equal(parse({ 'schema-version': 2 }).status, 'invalid');
    for (const username of [null, '', { 'from-environment': 'GH_USER' }]) {
      assert.equal(parse(policy, username).status, 'invalid');
    }
  });

  it('should reject incomplete pins and ambiguous identities within each authority list', () => {
    for (const key of ['issue-assignment', 'review-request', 'feedback']) {
      for (const allowed of [
        [{ login: 'pirog' }],
        [{ ...actor, 'node-id': 'contains space' }],
        [{ ...actor, 'operator-owner': 'true' }],
        [actor, { ...actor, login: 'renamed' }],
        [actor, { login: 'PIROG', 'node-id': 'U_other' }],
      ])
        assert.equal(parse({ ...policy, [key]: { allowed } }).status, 'invalid');
    }
    assert.equal(
      parse({ ...policy, 'allowed-repository-owners': [owner, { ...owner, login: 'renamed' }] })
        .status,
      'invalid',
    );
  });

  it('should leave legacy declarations unchanged and never project them into codex', () => {
    const result = parse({ 'approved-actors': [actor] });
    assert.ok(result.status === 'valid');
    const declaration = result.manifest.github?.notifications;
    assert.equal(legacyGitHubNotifications(declaration), declaration);
    assert.equal(githubNotificationRuntimeBlocker(declaration, 'codex'), undefined);
    assert.equal(githubNotificationRuntimeBlocker(undefined, 'codex'), undefined);
  });
});
