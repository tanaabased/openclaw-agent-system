import assert from 'node:assert/strict';

import parse from '../manifest/parse.ts';
import openclawIntakeJobs from '../agent/automations/openclaw-intake-policy.ts';
import { codexIntakeJobs } from '../agent/automations/codex-intake-policy.ts';
import { notificationAuthority } from '../agent/notification-authority.ts';
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

describe('issue pickup configuration', () => {
  for (const runtime of ['openclaw', 'codex'] as const) {
    it(`should retain current settings and saved authority in ${runtime}`, () => {
      const current = load(document('issue-pickup', 'issue-pickup', runtime));
      const canonical = current.manifest.github!.notifications!;
      assert.ok(canonical.issuePickup);
      assert.ok(!Object.hasOwn(canonical, 'projectPickup'));
      assert.deepEqual(canonical.issuePickup.projects, [
        { repository: 'owner/repo', milestone: { number: 10, policy: 'only' }, limit: 1 },
      ]);
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
      const pickup = jobs.filter(({ id }) => id === 'github-issue-pickup');
      assert.equal(pickup.length, 1);
      assert.deepEqual(pickup[0]!.schedule, canonical.issuePickup.scanSchedule);
      const repo = { name: 'archive', owner: { login: 'owner', nodeId: 'O_owner' } };
      assert.equal(repositoryScope(canonical, repo, 'issue-pickup').decision, 'deny');
      assert.equal(
        repositoryScope(canonical, { ...repo, name: 'repo' }, 'issue-pickup').decision,
        'local',
      );
      assert.equal(repositoryScope(canonical, repo, 'issue-assignment').reason, 'no-match');
    });

    it(`should project shared pickup defaults through ${runtime}`, () => {
      const source = document('issue-pickup', 'issue-pickup', runtime);
      source.github['issue-pickup'] = { projects: [{ repository: 'owner/repo' }] };
      const parsed = load(source);
      const policy = parsed.manifest.github!.notifications!.issuePickup!;
      assert.equal(policy.paused, false);
      assert.equal(policy.windowMinutes, 120);
      assert.deepEqual(policy.projects, [{ repository: 'owner/repo', limit: 1 }]);
      const project = runtime === 'codex' ? codexIntakeJobs : openclawIntakeJobs;
      const job = project(parsed.manifest).find(({ id }) => id === 'github-issue-pickup')!;
      assert.equal(job.schedule.kind, 'cron');
      if (job.schedule.kind !== 'cron') throw new Error('cron required');
      assert.deepEqual(job.schedule.times, [180, 195, 210, 225, 240, 255, 270, 285]);
      assert.equal(job.schedule.timezone, null);
      assert.equal(job.enabled, true);
      assert.equal(
        job.overrides[runtime]?.model,
        runtime === 'codex' ? 'gpt-6-luna' : 'openai/gpt-6-luna',
      );
      assert.equal(job.overrides[runtime]?.effort, 'medium');
    });

    it(`should preserve native type filters through ${runtime} configuration`, () => {
      const source = document('issue-pickup', 'issue-pickup', runtime);
      const filters = { types: ['Bug', 'Customer Request'], labels: ['ready*', '!blocked'] };
      source.github['issue-pickup'] = { projects: [{ repository: 'owner/repo', filters }] };
      const parsed = load(source);
      assert.deepEqual(
        parsed.manifest.github!.notifications!.issuePickup!.projects[0]!.filters,
        filters,
      );
      for (const types of ['', 'Bug', [42], [' '], ['']]) {
        source.github['issue-pickup'] = {
          projects: [{ repository: 'owner/repo', filters: { types } }],
        };
        assert.equal(parse(JSON.stringify(source)).status, 'invalid');
      }
    });
  }

  for (const both of [false, true]) {
    it(`should reject retired configuration${both ? ' beside the current key' : ''}`, () => {
      const source = document(both ? 'issue-pickup' : 'project-pickup', 'issue-pickup');
      source.github['project-pickup'] = pickupDeclaration;
      const result = parse(JSON.stringify(source));
      assert.equal(result.status, 'invalid');
      const diagnostic = result.diagnostics.find(
        ({ code }) => code === 'github-project-pickup-removed',
      );
      assert.equal(diagnostic?.fieldPath, '/github/project-pickup');
      assert.equal(diagnostic?.severity, 'error');
      assert.match(diagnostic!.message, /github\.issue-pickup/);
    });
  }

  it(`should reject the retired routing workflow`, () => {
    const source = document('issue-pickup', 'project-pickup');
    const result = parse(JSON.stringify(source));
    assert.equal(result.status, 'invalid');
    const diagnostic = result.diagnostics.find(
      ({ code }) => code === 'github-routing-project-pickup-removed',
    );
    assert.equal(diagnostic?.fieldPath, '/github/routing/0/workflows');
    assert.match(diagnostic!.message, /issue-pickup/);
  });
  it('should reject invalid current settings', () => {
    const source = document();
    source.github['issue-pickup'] = { ...pickupDeclaration, scans: 0 };
    assert.equal(parse(JSON.stringify(source)).status, 'invalid');
    source.github['issue-pickup'] = { ...pickupDeclaration, model: 'missing' };
    const result = parse(JSON.stringify(source));
    assert.equal(result.status, 'invalid');
    assert.ok(
      result.diagnostics.some(({ fieldPath }) => fieldPath === '/github/issue-pickup/model'),
    );
  });

  it('should reject mixed retired and current routing workflows', () => {
    const source = document();
    source.github.routing[0]!.workflows = ['project-pickup', 'issue-pickup'];
    assert.equal(parse(JSON.stringify(source)).status, 'invalid');
  });
});
