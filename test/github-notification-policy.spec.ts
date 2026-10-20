import assert from 'node:assert/strict';

import { stringify } from 'yaml';

import { notificationAuthorityDigest } from '../agent/notification-authority.ts';
import {
  githubNotificationRuntimeBlocker,
  githubNotificationRuntimeDiagnostics,
} from '../channels/github/notification-policy.ts';
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
  for (const version of [undefined, 2])
    it(`should normalize pause aliases and reject contradictions with ${version ?? 'omitted'} notification version`, () => {
      const currentPolicy = { ...policy, 'schema-version': version };
      for (const key of ['issue-assignment', 'review-request'] as const) {
        const decoded = key === 'issue-assignment' ? 'issueAssignment' : 'reviewRequest';
        for (const paused of [true, false]) {
          for (const declaration of [
            { paused },
            { enabled: !paused },
            { paused, enabled: !paused },
          ]) {
            const result = parse({ ...currentPolicy, [key]: declaration });
            assert.ok(result.status === 'valid');
            assert.equal(result.manifest.github!.notifications![decoded]!.paused, paused);
            assert.equal(result.manifest.github!.notifications![decoded]!.enabled, undefined);
            const diagnostic = result.diagnostics.find(
              ({ code }) => code === 'github-notification-enabled-deprecated',
            );
            assert.equal(Boolean(diagnostic), 'enabled' in declaration);
            if (diagnostic) {
              assert.equal(diagnostic.severity, 'warning');
              assert.equal(diagnostic.fieldPath, `/github/notifications/${key}/enabled`);
              assert.ok(diagnostic.message.includes(`paused: ${paused}`));
            }
          }
          const conflict = parse({ ...currentPolicy, [key]: { paused, enabled: paused } });
          assert.equal(conflict.status, 'invalid');
          assert.ok(
            conflict.diagnostics.some(({ code }) => code === 'github-notification-pause-conflict'),
          );
        }
        for (const paused of ['true', 0, null])
          assert.equal(parse({ ...currentPolicy, [key]: { paused } }).status, 'invalid');
      }
    });

  it('should normalize omitted and explicit notification versions without authority drift', () => {
    for (const runtimes of [['openclaw'], ['codex'], ['openclaw', 'codex']]) {
      const unversioned = {
        'allowed-repository-owners': [owner],
        runtimes,
        'issue-assignment': { allowed: [actor], mode: 'plan', feedback: true },
      };
      const omitted = parsed(unversioned);
      const explicit = parsed({ ...unversioned, 'schema-version': 2 });
      assert.equal(omitted.schemaVersion, 2);
      assert.deepEqual(omitted, explicit);
      assert.equal(notificationAuthorityDigest(omitted), notificationAuthorityDigest(explicit));
    }
    const absent = parse(undefined);
    assert.ok(absent.status === 'valid');
    assert.equal(absent.manifest.github?.notifications, undefined);
  });

  it('should reject every unsupported explicit notification version', () => {
    for (const version of [1, 0, 3, 2.5, '2', null, false, [], {}]) {
      const result = parse({ ...policy, 'schema-version': version });
      assert.equal(result.status, 'invalid', JSON.stringify(version));
      assert.ok(
        result.diagnostics.some(
          ({ code }) =>
            code === (version === 1 ? 'github-notification-v1-retired' : 'manifest-schema'),
        ),
      );
    }
  });

  it('should diagnose missing current policy fields without classifying omission as v1', () => {
    for (const current of [{}, { 'issue-assignment': { allowed: [actor] } }]) {
      const result = parse(current);
      assert.equal(result.status, 'invalid');
      assert.ok(
        result.diagnostics.some(
          ({ code, fieldPath }) =>
            code === 'manifest-required-key' &&
            fieldPath === '/github/notifications/allowed-repository-owners',
        ),
      );
      assert.ok(result.diagnostics.every(({ code }) => code !== 'github-notification-v1-retired'));
    }
  });

  it('should diagnose removed global feedback only for current-format notification policies', () => {
    for (const version of [undefined, 2]) {
      const result = parse({ ...policy, 'schema-version': version, feedback: false });
      assert.equal(result.status, 'invalid');
      assert.ok(
        result.diagnostics.some(
          ({ code }) => code === 'github-notification-global-feedback-removed',
        ),
      );
    }
    for (const invalid of [
      { ...policy, 'schema-version': 3 },
      { ...policy, 'schema-version': 1 },
      { 'approved-actors': [actor] },
      {},
    ]) {
      const result = parse({ ...invalid, feedback: false });
      assert.equal(result.status, 'invalid');
      assert.ok(
        result.diagnostics.every(
          ({ code }) => code !== 'github-notification-global-feedback-removed',
        ),
      );
    }
  });

  it('should reject retired unversioned notifications with explicit migration guidance', () => {
    for (const old of [{ 'approved-actors': [actor] }, { 'assignment-types': ['issue'] }]) {
      const result = parse(old);
      assert.equal(result.status, 'invalid');
      const diagnostic = result.diagnostics.find(
        (d) => d.code === 'github-notification-v1-retired',
      );
      assert.equal(diagnostic?.fieldPath, '/github/notifications');
      assert.match(diagnostic?.message ?? '', /schema-version: 2/u);
    }
  });

  it('should allow openclaw planning while naming unsupported enabled capabilities', () => {
    const supported = {
      ...policy,
      runtimes: ['openclaw', 'codex'],
      'issue-assignment': { allowed: [actor], mode: 'plan', feedback: false },
      'review-request': undefined,
    };
    assert.equal(githubNotificationRuntimeBlocker(parsed(supported), 'openclaw'), undefined);
    for (const [extra, capability] of [
      [{ assessment: { skill: 'custom:assess' } }, 'replacement assessment skills'],
    ] as const) {
      const declaration = parsed({
        ...supported,
        'issue-assignment': { ...supported['issue-assignment'], ...extra },
      });
      assert.ok(
        githubNotificationRuntimeDiagnostics(declaration, 'openclaw').some(({ message }) =>
          message.includes(capability),
        ),
      );
      assert.equal(githubNotificationRuntimeBlocker(declaration, 'openclaw'), undefined);
      assert.equal(githubNotificationRuntimeBlocker(declaration, 'codex'), undefined);
      declaration.issueAssignment!.enabled = false;
      assert.equal(githubNotificationRuntimeBlocker(declaration, 'openclaw'), undefined);
    }
    for (const mode of ['work', 'auto']) {
      assert.deepEqual(
        githubNotificationRuntimeDiagnostics(
          parsed({
            ...supported,
            'issue-assignment': { ...supported['issue-assignment'], mode },
          }),
          'openclaw',
        ),
        [],
      );
    }
    const review = parsed({ ...supported, 'review-request': { allowed: [{ ...actor }] } });
    assert.equal(githubNotificationRuntimeBlocker(review, 'openclaw'), undefined);
    assert.ok(
      githubNotificationRuntimeDiagnostics(review, 'openclaw').some(
        ({ status, workflow }) => status === 'warning' && workflow === 'review-request',
      ),
    );
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

  it('should report every unavailable capability without hiding required assignment blockers', () => {
    const declaration = parsed({
      ...policy,
      'issue-assignment': {
        allowed: [actor],
        mode: 'work',
        feedback: true,
        assessment: { skill: 'custom:assess' },
      },
      'review-request': { allowed: [{ ...actor }] },
    });
    const diagnostics = githubNotificationRuntimeDiagnostics(declaration, 'openclaw');
    assert.deepEqual(
      new Set(
        diagnostics.filter(({ status }) => status === 'warning').map(({ fieldPath }) => fieldPath),
      ),
      new Set([
        '/github/notifications/review-request',
        '/github/notifications/issue-assignment/assessment/skill',
      ]),
    );
    assert.deepEqual(
      new Set(
        diagnostics.filter(({ status }) => status === 'blocked').map(({ fieldPath }) => fieldPath),
      ),
      new Set(),
    );
    assert.equal(githubNotificationRuntimeBlocker(declaration, 'openclaw'), undefined);
    assert.deepEqual(
      githubNotificationRuntimeDiagnostics(declaration, 'codex').map(({ workflow, status }) => ({
        workflow,
        status,
      })),
      [{ workflow: 'review-request', status: 'warning' }],
    );
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
          assert.equal(declaration[decoded]?.paused, enabled === undefined ? undefined : !enabled);
          assert.equal(declaration[decoded]?.allowed.length, allowed?.length ?? 0);
          assert.equal(
            githubNotificationRuntimeDiagnostics(declaration, 'openclaw')[0]?.code,
            key === 'review-request' && (enabled !== undefined || Boolean(allowed?.length))
              ? 'github-notification-runtime-unsupported'
              : undefined,
          );
          assert.equal(
            githubNotificationRuntimeDiagnostics(declaration, 'codex')[0]?.code,
            key !== 'issue-assignment' && (enabled !== undefined || Boolean(allowed?.length))
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
      cleanup: { enabled: true, graceMinutes: 60 },
      allowedRepositoryOwners: [{ login: owner.login, nodeId: owner['node-id'] }],
    });
    const declaration = parsed({ ...policy, 'issue-assignment': {} });
    assert.deepEqual(declaration.issueAssignment, { allowed: [], mode: 'auto' });
    assert.equal(declaration.reviewRequest, undefined);
  });

  it('should configure cleanup separately from admission and reject invalid grace periods', () => {
    assert.deepEqual(
      parsed({ ...policy, cleanup: { enabled: false, 'grace-minutes': 30 } }).cleanup,
      {
        enabled: false,
        graceMinutes: 30,
      },
    );
    for (const minutes of [-1, 1.5, 43201])
      assert.equal(parse({ ...policy, cleanup: { 'grace-minutes': minutes } }).status, 'invalid');
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
});
