import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import repositoryScope, {
  repositoryPatternSchema,
  repositoryRouteSchema,
  repositoryScopeCandidate,
} from '../channels/github/repository-scope.ts';
import {
  notificationAuthorityDigest,
  feedbackAuthorityDigest,
} from '../agent/notification-authority.ts';
import { normalizeAgentManifest } from '../manifest/parse.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('channels/github/repository-scope', () => {
  const assignmentScope = (
    policy: Parameters<typeof repositoryScope>[0],
    repository: Parameters<typeof repositoryScope>[1],
  ) => repositoryScope(policy, repository, 'issue-assignment');
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';

  it('should normalize uuid targets and unordered pools without falling through', () => {
    const { policy, repository } = intakeFixture();
    for (const target of [a, [a], [b, a]]) {
      policy.routing = [{ 'owner/repo': target }, 'owner/*'];
      const decision = assignmentScope(policy, repository);
      assert.equal(decision.decision, 'swarm');
      assert.equal(decision.index, 0);
      assert.deepEqual(
        decision.eligibleInstanceIds,
        typeof target === 'string' ? [a] : [...target].sort(),
      );
      assert.equal(repositoryScopeCandidate(policy, 'owner', 'repo', 'issue-assignment'), true);
      const parsed = normalizeAgentManifest({
        'schema-version': 1,
        agent: { id: 'receiver' },
        github: { username: 'receiver', routing: policy.routing },
      });
      assert.equal(parsed.status, 'valid', JSON.stringify(parsed.diagnostics));
    }
    for (const target of [[], [a, a], [a, 'local'], ['swarm'], 'my-laptop', a + '\n', [b, null]])
      assert.equal(Value.Check(repositoryRouteSchema, { 'owner/repo': target }), false);
    policy.routing = [{ 'owner/repo': [b, a] }];
    const digest = () => [notificationAuthorityDigest(policy), feedbackAuthorityDigest(policy)];
    const before = digest();
    policy.routing = [{ 'owner/repo': [a, b] }];
    assert.deepEqual(digest(), before);
    policy.routing = [{ 'owner/repo': a }];
    const singleton = digest();
    policy.routing = [{ 'owner/repo': [a] }];
    assert.deepEqual(digest(), singleton);
  });

  it('should match repository and workflow in order with equivalent compact and full forms', () => {
    const { policy, repository } = intakeFixture();
    const digest = () => [notificationAuthorityDigest(policy), feedbackAuthorityDigest(policy)];
    policy.routing = ['!owner/archive', { 'owner/repo': [b, a] }, 'owner/*', '*/*'];
    const shorthand = digest();
    policy.routing = [
      { id: 'archived', match: 'owner/archive', target: 'deny' },
      {
        id: 'main-pool',
        match: 'OWNER/REPO',
        workflows: ['review-request', 'project-pickup', 'issue-assignment'],
        target: { instances: [a, b] },
      },
      { 'owner/*': 'local' },
      { match: '*/*', target: 'local' },
    ];
    assert.deepEqual(digest(), shorthand);
    policy.routing.unshift({
      id: 'review-or-pickup',
      match: 'owner/repo',
      workflows: ['review-request', 'project-pickup'],
      target: { instance: b },
    });
    for (const workflow of ['review-request', 'project-pickup'] as const) {
      const result = repositoryScope(policy, repository, workflow);
      assert.equal(result.ruleId, 'review-or-pickup');
      assert.equal(result.decision, 'swarm');
      assert.deepEqual(result.eligibleInstanceIds, [b]);
    }
    const assignment = assignmentScope(policy, repository);
    assert.equal(assignment.ruleId, 'main-pool');
    assert.deepEqual(assignment.eligibleInstanceIds, [a, b]);
    assert.equal(assignmentScope(policy, { ...repository, name: 'archive' }).decision, 'deny');
    const other = { ...repository, owner: { ...repository.owner, login: 'another' } };
    assert.equal(assignmentScope(policy, other).pattern, '*/*');
    policy.routing.pop();
    assert.equal(assignmentScope(policy, other).reason, 'no-match');
  });

  it('should diagnose duplicate ids and proven shadowing only for covered workflows', () => {
    const parse = (routing: unknown) =>
      normalizeAgentManifest({
        'schema-version': 1,
        agent: { id: 'receiver' },
        github: { username: 'receiver', routing },
      });
    const review = {
      id: 'review',
      match: 'owner/*',
      workflows: ['review-request'],
      target: 'deny',
    };
    const result = parse([
      review,
      { id: 'covered', match: 'owner/repo', workflows: ['review-request'], target: 'local' },
      { id: 'partial', match: 'owner/repo', target: 'local' },
      '*/*',
      { id: 'after-fallback', match: 'elsewhere/*', target: 'swarm' },
    ]);
    assert.equal(result.status, 'valid');
    assert.deepEqual(
      result.diagnostics
        .filter(({ code }) => code === 'github-routing-rule-unreachable')
        .map(({ fieldPath }) => fieldPath),
      ['/github/routing/1', '/github/routing/4'],
    );
    const duplicate = parse([review, { ...review, match: 'elsewhere/*' }]);
    assert.equal(duplicate.status, 'invalid');
    assert.ok(
      duplicate.diagnostics.some(({ code }) => code === 'github-routing-duplicate-rule-id'),
    );
    for (const rule of [
      { match: 'owner/repo' },
      { target: 'local' },
      { match: '!owner/repo', target: 'deny' },
      { ...review, 'owner/repo': 'local' },
      { ...review, unexpected: 'local' },
      { ...review, id: '' },
      { ...review, workflows: [] },
      { ...review, workflows: ['review-request', 'review-request'] },
      { ...review, workflows: ['issue'] },
      { ...review, target: a },
      { ...review, target: { instances: [a, a] } },
      { ...review, target: { instance: a, instances: [b] } },
      { local: 'swarm' },
    ])
      assert.equal(parse([rule]).status, 'invalid', JSON.stringify(rule));
  });
  it('should resolve local and swarm targets in the same ordered scope', () => {
    const { policy, repository } = intakeFixture();
    policy.routing = ['!owner/archive-*', { 'OWNER/REPO': 'swarm' }, 'owner/*'];
    assert.deepEqual(assignmentScope(policy, repository), {
      source: 'routing',
      decision: 'swarm',
      reason: 'match',
      index: 1,
      pattern: 'OWNER/REPO',
    });
    assert.equal(repositoryScopeCandidate(policy, 'owner', 'repo', 'issue-assignment'), true);
    policy.routing.unshift({ 'owner/*': 'local' });
    assert.equal(assignmentScope(policy, repository).decision, 'local');
    for (const route of ['owner/*', '!owner/repo', { 'owner/*': 'local' }, { '*/*': 'swarm' }])
      assert.equal(Value.Check(repositoryRouteSchema, route), true);
    for (const route of [
      {},
      { '!owner/repo': 'swarm' },
      { 'owner/repo': 'remote' },
      { 'owner/repo': 'swarm', 'owner/other': 'local' },
      { 'owner/**': 'swarm' },
    ])
      assert.equal(Value.Check(repositoryRouteSchema, route), false, JSON.stringify(route));
  });

  it('should use the first case-insensitive match with segment-local wildcards', () => {
    const { policy, repository } = intakeFixture();
    policy.routing = ['!OWNER/REPO', 'owner/*'];
    assert.deepEqual(assignmentScope(policy, repository), {
      source: 'routing',
      decision: 'deny',
      reason: 'excluded',
      index: 0,
      pattern: '!OWNER/REPO',
    });
    policy.routing.reverse();
    assert.equal(assignmentScope(policy, repository).decision, 'local');
    for (const pattern of ['OWNER/REPO', 'own*/rep*', '*/repo', '*/*']) {
      policy.routing = [pattern];
      assert.equal(assignmentScope(policy, repository).decision, 'local', pattern);
    }
    policy.routing = ['owner/rep'];
    assert.equal(assignmentScope(policy, repository).reason, 'no-match');
    policy.routing = ['owner/*'];
    assert.equal(
      assignmentScope(policy, { ...repository, name: 'nested/repo' }).reason,
      'no-match',
    );
    policy.routing = [];
    assert.deepEqual(assignmentScope(policy, repository), {
      source: 'routing',
      decision: 'deny',
      reason: 'no-match',
    });
  });

  it('should reject unsupported glob expressions and target forms', () => {
    for (const pattern of [
      '',
      '*',
      'owner/',
      '/repo',
      'owner/**',
      '**/repo',
      'owner/r?po',
      'owner/[repo]',
      'owner/{a,b}',
      'owner/rep\\*',
      'owner/repo/extra',
      ' owner/repo',
      'owner/repo\n',
      '!!owner/repo',
      'https://github.com/owner/repo',
      { pattern: 'owner/*', target: 'swarm' },
    ])
      assert.equal(Value.Check(repositoryPatternSchema, pattern), false, JSON.stringify(pattern));
  });

  it('should match current names without transferring legacy identity pins', () => {
    const { policy, repository } = intakeFixture();
    policy.routing = ['owner/repo'];
    assert.equal(assignmentScope(policy, { ...repository, name: 'renamed' }).decision, 'deny');
    assert.equal(
      assignmentScope(policy, { ...repository, owner: { ...repository.owner, login: 'new-owner' } })
        .decision,
      'deny',
    );
    const replacement = {
      ...repository,
      nodeId: 'R_replacement',
      owner: { ...repository.owner, nodeId: 'O_replacement' },
    };
    assert.equal(assignmentScope(policy, replacement).decision, 'local');
    delete policy.routing;
    assert.equal(assignmentScope(policy, replacement).reason, 'identity-mismatch');
    assert.equal(assignmentScope(policy, repository).decision, 'local');
    policy.allowedRepositoryOwners = [{ login: '', nodeId: 'O_owner', reference: 'O_owner' }];
    assert.equal(repositoryScopeCandidate(policy, 'owner', 'repo', 'issue-assignment'), true);
    assert.equal(assignmentScope(policy, repository).decision, 'deny');
    policy.allowedRepositoryOwners[0]!.login = 'owner';
    assert.equal(assignmentScope(policy, repository).decision, 'local');
  });

  it('should preserve route order in effective policy without hashing ignored legacy owners', () => {
    const { policy } = intakeFixture();
    policy.routing = ['!owner/repo', 'owner/*'];
    const digest = () => [notificationAuthorityDigest(policy), feedbackAuthorityDigest(policy)];
    const before = digest();
    policy.allowedRepositoryOwners = [{ login: 'ignored', nodeId: 'O_ignored' }];
    assert.deepEqual(digest(), before);
    policy.routing.reverse();
    assert.ok(digest().every((value, index) => value !== before[index]));
  });

  it('should select routing by presence and warn without interpreting legacy content', () => {
    const parse = (github: Record<string, unknown>) =>
      normalizeAgentManifest({
        'schema-version': 1,
        agent: { id: 'receiver' },
        github: { username: 'receiver', ...github },
      });
    const routes = [
      '!owner/archive-*',
      { 'owner/repo': 'swarm' },
      { 'owner/*': 'local' },
      'pirog/*',
    ];
    const routed = parse({ routing: routes });
    assert.equal(routed.status, 'valid', JSON.stringify(routed.diagnostics));
    if (routed.status !== 'valid') throw Error('invalid routing fixture');
    assert.deepEqual(routed.manifest.github!.notifications!.routing, routes);
    for (const legacy of [undefined, null, [], 'obsolete', [{ broken: true }]]) {
      const input = {
        routing: [],
        ...(legacy === undefined ? {} : { 'allowed-repository-owners': legacy }),
      };
      const result = parse(input);
      assert.equal(result.status, 'valid', JSON.stringify(result.diagnostics));
      if (result.status !== 'valid') throw Error('invalid routing fixture');
      assert.deepEqual(result.manifest.github!.notifications!.routing, []);
      assert.deepEqual(result.manifest.github!.notifications!.allowedRepositoryOwners, []);
      assert.equal(
        result.diagnostics.some(({ code }) => code === 'github-repository-owners-ignored'),
        legacy !== undefined,
      );
    }
    for (const routing of [null, false, 'owner/*', ['owner/**'], [{ pattern: 'owner/*' }]])
      assert.equal(parse({ routing, 'allowed-repository-owners': ['@owner'] }).status, 'invalid');
    assert.equal(parse({ 'issue-assignment': {} }).status, 'invalid');
    assert.equal(parse({ 'allowed-repository-owners': [] }).status, 'invalid');
    const legacy = parse({ 'allowed-repository-owners': ['@owner', 'O_second'] });
    assert.equal(legacy.status, 'valid');
    if (legacy.status !== 'valid') throw Error('invalid legacy fixture');
    assert.equal(legacy.manifest.github!.notifications!.routing, undefined);
    assert.equal(legacy.diagnostics[0]!.code, 'github-repository-owners-deprecated');
    assert.equal(
      legacy.manifest.github!.notifications!.allowedRepositoryOwners[1]!.reference,
      'O_second',
    );
  });
});
