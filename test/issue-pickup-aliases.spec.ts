import assert from 'node:assert/strict';

import parse from '../manifest/parse.ts';
import openclawIntakeJobs from '../agent/automations/openclaw-intake-policy.ts';
import { codexIntakeJobs } from '../agent/automations/codex-intake-policy.ts';
import {
  feedbackAuthorityDigest,
  notificationAuthority,
  notificationAuthorityDigest,
} from '../agent/notification-authority.ts';
import { issuePickupPolicyDigest } from '../agent/issue-pickup-authority.ts';
import repositoryScope from '../channels/github/repository-scope.ts';
import { pickupDeclaration } from './issue-pickup-fixture.ts';

function document(key = 'issue-pickup', workflow = 'issue-pickup', runtime = 'openclaw') {
  return {
    'schema-version': 1,
    agent: { id: 'receiver' },
    models: Object.fromEntries(
      ['default', 'low', 'medium', 'high'].map((name) => [
        name,
        { model: 'openai/gpt-6-luna', effort: 'medium' },
      ]),
    ),
    github: {
      username: 'receiver',
      runtimes: [runtime],
      routing: [
        { match: 'owner/archive', workflows: [workflow], target: 'deny' },
        { match: 'owner/*', workflows: [workflow], target: 'local' },
      ],
      'issue-assignment': {},
      [key]: { ...pickupDeclaration } as Record<string, unknown>,
    },
  };
}
function load(source: unknown) {
  const parsed = parse(JSON.stringify(source));
  assert.equal(parsed.status, 'valid', JSON.stringify(parsed.diagnostics));
  if (parsed.status !== 'valid') throw new Error('invalid fixture');
  return parsed;
}

describe('issue pickup input aliases', () => {
  for (const runtime of ['openclaw', 'codex']) {
    it(`should normalize either input spelling into the same ${runtime} policy and automation`, () => {
      const current = load(document('issue-pickup', 'issue-pickup', runtime));
      const old = load(document('project-pickup', 'project-pickup', runtime));
      assert.deepEqual(old.manifest, current.manifest);
      const canonical = current.manifest.github!.notifications!;
      const legacy = old.manifest.github!.notifications!;
      assert.ok(canonical.issuePickup);
      assert.ok(!Object.hasOwn(canonical, 'projectPickup'));
      assert.equal(notificationAuthorityDigest(legacy), notificationAuthorityDigest(canonical));
      assert.equal(feedbackAuthorityDigest(legacy), feedbackAuthorityDigest(canonical));
      assert.equal(issuePickupPolicyDigest(legacy), issuePickupPolicyDigest(canonical));
      // retained authorization uses its original serialized key and workflow value.
      const authority = notificationAuthority(canonical);
      assert.ok(Object.hasOwn(authority, 'projectPickup'));
      assert.ok(!Object.hasOwn(authority, 'issuePickup'));
      assert.deepEqual(authority.routing, [
        { match: 'owner/archive', workflows: ['project-pickup'], target: 'deny' },
        { match: 'owner/*', workflows: ['project-pickup'], target: 'local' },
      ]);
      const project = runtime === 'codex' ? codexIntakeJobs : openclawIntakeJobs;
      const jobs = project(current.manifest);
      assert.deepEqual(project(old.manifest), jobs);
      assert.equal(jobs.filter(({ id }) => id === 'github-issue-pickup').length, 1);
      const repo = { name: 'archive', owner: { login: 'owner', nodeId: 'O_owner' } };
      assert.equal(repositoryScope(legacy, repo, 'issue-pickup').decision, 'deny');
      assert.equal(
        repositoryScope(canonical, { ...repo, name: 'repo' }, 'issue-pickup').decision,
        'local',
      );
      assert.equal(old.diagnostics.filter(({ severity }) => severity === 'warning').length, 2);
      assert.ok(!current.diagnostics.some(({ code }) => code.includes('alias-deprecated')));
    });
  }

  it('should reject both configuration keys even when their settings are identical', () => {
    const source = document();
    source.github['project-pickup'] = pickupDeclaration;
    const result = parse(JSON.stringify(source));
    assert.equal(result.status, 'invalid');
    assert.ok(result.diagnostics.some(({ code }) => code === 'github-issue-pickup-alias-conflict'));
  });

  it('should validate legacy input instead of silently dropping invalid settings', () => {
    for (const key of ['issue-pickup', 'project-pickup']) {
      const source = document(key);
      source.github[key] = { ...pickupDeclaration, scans: 0 };
      assert.equal(parse(JSON.stringify(source)).status, 'invalid');
      source.github[key] = { ...pickupDeclaration, model: 'missing' };
      const result = parse(JSON.stringify(source));
      assert.equal(result.status, 'invalid');
      assert.ok(result.diagnostics.some(({ fieldPath }) => fieldPath === `/github/${key}/model`));
    }
  });

  it('should deduplicate equivalent routing aliases without widening workflow scope', () => {
    const source = document();
    source.github.routing[0]!.workflows = ['project-pickup', 'issue-pickup'];
    const policy = load(source).manifest.github!.notifications!;
    assert.deepEqual((policy.routing![0] as { workflows: string[] }).workflows, ['issue-pickup']);
    const repo = { name: 'archive', owner: { login: 'owner', nodeId: 'O_owner' } };
    assert.equal(repositoryScope(policy, repo, 'issue-pickup').decision, 'deny');
    assert.equal(repositoryScope(policy, repo, 'issue-assignment').reason, 'no-match');
  });
});
