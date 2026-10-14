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
  it('should allow openclaw planning while naming unsupported enabled capabilities', () => {
    const supported = {
      ...policy,
      runtimes: ['openclaw', 'codex'],
      'issue-assignment': { allowed: [actor], mode: 'plan', feedback: false },
      'review-request': { enabled: false, allowed: [{ ...actor }], feedback: true },
    };
    assert.equal(githubNotificationRuntimeBlocker(parsed(supported), 'openclaw'), undefined);
    for (const [extra, capability] of [
      [{ mode: 'work' }, 'work issue assignment'],
      [{ mode: 'auto' }, 'auto issue assignment'],
      [{ feedback: true }, 'issue feedback'],
      [{ feedback: { allowed: [{ ...actor }] } }, 'issue feedback'],
      [{ assessment: { skill: 'custom:assess' } }, 'replacement assessment skills'],
    ] as const) {
      const declaration = parsed({
        ...supported,
        'issue-assignment': { ...supported['issue-assignment'], ...extra },
      });
      assert.ok(
        githubNotificationRuntimeBlocker(declaration, 'openclaw')?.message.includes(capability),
      );
      assert.equal(githubNotificationRuntimeBlocker(declaration, 'codex'), undefined);
      declaration.issueAssignment!.enabled = false;
      assert.equal(githubNotificationRuntimeBlocker(declaration, 'openclaw'), undefined);
    }
    const review = parsed({ ...supported, 'review-request': { allowed: [{ ...actor }] } });
    assert.match(githubNotificationRuntimeBlocker(review, 'openclaw')!.message, /review requests/);
    for (const skill of [
      'agent-system-issue-assessment',
      'agent-system:agent-system-issue-assessment',
    ]) {
      assert.equal(
        githubNotificationRuntimeBlocker(
          parsed({
            ...supported,
            'issue-assignment': { ...supported['issue-assignment'], assessment: { skill } },
          }),
          'openclaw',
        ),
        undefined,
      );
    }
  });

  it('should preserve trigger switches and authority independently of adapter availability', () => {
    for (const [key, decoded] of [
      ['issue-assignment', 'issueAssignment'],
      ['review-request', 'reviewRequest'],
    ] as const) {
      for (const enabled of [undefined, true, false]) {
        for (const allowed of [undefined, [], [actor]]) {
          const declaration = parsed({
            ...policy,
            [key]: { allowed, ...(enabled === undefined ? {} : { enabled }) },
          });
          assert.equal(declaration[decoded]?.enabled, enabled);
          assert.equal(declaration[decoded]?.allowed.length, allowed?.length ?? 0);
          assert.equal(
            githubNotificationRuntimeBlocker(declaration, 'openclaw')?.code,
            key === 'review-request' && (enabled ?? Boolean(allowed?.length))
              ? 'github-notification-runtime-unsupported'
              : undefined,
          );
          assert.equal(
            githubNotificationRuntimeBlocker(declaration, 'codex')?.code,
            key !== 'issue-assignment' && (enabled ?? Boolean(allowed?.length))
              ? 'github-notification-runtime-unsupported'
              : undefined,
          );
        }
      }
      for (const enabled of ['false', 0, null])
        assert.equal(parse({ ...policy, [key]: { enabled } }).status, 'invalid');
      assert.equal(
        parse({ ...policy, [key]: { enabled: false, allowed: [{ login: 'missing-pin' }] } }).status,
        'invalid',
      );
    }
    const mixed = parsed({
      ...policy,
      runtimes: ['codex'],
      'issue-assignment': { allowed: [{ ...actor }] },
      'review-request': { enabled: false, allowed: [{ ...actor }] },
    });
    assert.equal(githubNotificationRuntimeBlocker(mixed, 'codex'), undefined);
    mixed.issueAssignment!.feedback = true;
    assert.equal(githubNotificationRuntimeBlocker(mixed, 'codex'), undefined);
    assert.equal(parse({ 'approved-actors': [actor], enabled: false }).status, 'invalid');
  });
  it('should normalize assessment skill ids and retain optional guidance forms', () => {
    for (const [skill, normalized] of [
      ['assess', 'assess'],
      ['$assess', 'assess'],
      ['company:assess', 'company:assess'],
      [' $company:assess ', 'company:assess'],
    ]) {
      for (const guidance of [
        undefined,
        'Prefer small fixes.',
        'First investigate.\nThen plan.',
        { file: 'guidance/assessment.md' },
      ]) {
        const assessment = parsed({
          ...policy,
          'issue-assignment': {
            assessment: { skill, ...(guidance === undefined ? {} : { guidance }) },
          },
        }).issueAssignment!.assessment!;
        assert.equal(assessment.skill, normalized);
        assert.deepEqual(assessment.guidance, guidance);
      }
    }
    assert.deepEqual(
      parsed({ ...policy, 'issue-assignment': { assessment: { guidance: 'Be concise.' } } })
        .issueAssignment!.assessment,
      { guidance: 'Be concise.' },
    );
    for (const assessment of [
      { skill: 'run arbitrary instructions' },
      { skill: { file: 'SKILL.md' } },
      { skill: { inline: 'Assess.' } },
      { skill: '$' },
      { skill: 'a\nb' },
      { skill: '../skill' },
      { guidance: '' },
      { guidance: { file: 'guide.md', inline: 'Also this' } },
      { implementation: {} },
    ])
      assert.equal(parse({ ...policy, 'issue-assignment': { assessment } }).status, 'invalid');
  });
  it('should decode portable defaults without manufacturing trigger authority', () => {
    assert.deepEqual(parsed(policy), {
      schemaVersion: 2,
      runtimes: ['openclaw', 'codex'],
      intervalMinutes: 5,
      maxConcurrentItems: 3,
      allowedRepositoryOwners: [{ login: owner.login, nodeId: owner['node-id'] }],
    });
    const declaration = parsed({ ...policy, 'issue-assignment': {} });
    assert.deepEqual(declaration.issueAssignment, { allowed: [], mode: 'plan' });
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
        'issue-assignment': {
          allowed: [{ ...actor, 'operator-owner': true }],
          mode,
          feedback: true,
        },
        'review-request': { allowed: [] },
      });
      assert.deepEqual(declaration.issueAssignment, {
        allowed: [{ login: actor.login, nodeId: actor['node-id'], operatorOwner: true }],
        mode,
        feedback: true,
      });
      assert.deepEqual(declaration.reviewRequest?.allowed, []);
      assert.equal(declaration.issueAssignment?.feedback, true);
      assert.equal(declaration.intervalMinutes, 10);
      assert.equal(declaration.maxConcurrentItems, 3);
      assert.equal(githubNotificationRuntimeBlocker(declaration, 'codex'), undefined);
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
    for (const key of ['issue-assignment', 'review-request']) {
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
