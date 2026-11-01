import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import repositoryScope, {
  repositoryPatternSchema,
  repositoryScopeCandidate,
} from '../channels/github/repository-scope.ts';
import {
  notificationAuthorityDigest,
  feedbackAuthorityDigest,
} from '../agent/notification-authority.ts';
import { normalizeAgentManifest } from '../manifest/parse.ts';
import { intakeFixture } from './github-intake-fixture.ts';

describe('channels/github/repository-scope', () => {
  it('should use the first case-insensitive match with segment-local wildcards', () => {
    const { policy, repository } = intakeFixture();
    policy.routing = ['!OWNER/REPO', 'owner/*'];
    assert.deepEqual(repositoryScope(policy, repository), {
      source: 'routing',
      decision: 'deny',
      reason: 'excluded',
      index: 0,
      pattern: '!OWNER/REPO',
    });
    policy.routing.reverse();
    assert.equal(repositoryScope(policy, repository).decision, 'local');
    for (const pattern of ['OWNER/REPO', 'own*/rep*', '*/repo', '*/*']) {
      policy.routing = [pattern];
      assert.equal(repositoryScope(policy, repository).decision, 'local', pattern);
    }
    policy.routing = ['owner/rep'];
    assert.equal(repositoryScope(policy, repository).reason, 'no-match');
    policy.routing = ['owner/*'];
    assert.equal(
      repositoryScope(policy, { ...repository, name: 'nested/repo' }).reason,
      'no-match',
    );
    policy.routing = [];
    assert.deepEqual(repositoryScope(policy, repository), {
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
    assert.equal(repositoryScope(policy, { ...repository, name: 'renamed' }).decision, 'deny');
    assert.equal(
      repositoryScope(policy, { ...repository, owner: { ...repository.owner, login: 'new-owner' } })
        .decision,
      'deny',
    );
    const replacement = {
      ...repository,
      nodeId: 'R_replacement',
      owner: { ...repository.owner, nodeId: 'O_replacement' },
    };
    assert.equal(repositoryScope(policy, replacement).decision, 'local');
    delete policy.routing;
    assert.equal(repositoryScope(policy, replacement).reason, 'identity-mismatch');
    assert.equal(repositoryScope(policy, repository).decision, 'local');
    policy.allowedRepositoryOwners = [{ login: '', nodeId: 'O_owner', reference: 'O_owner' }];
    assert.equal(repositoryScopeCandidate(policy, 'owner', 'repo'), true);
    assert.equal(repositoryScope(policy, repository).decision, 'deny');
    policy.allowedRepositoryOwners[0]!.login = 'owner';
    assert.equal(repositoryScope(policy, repository).decision, 'local');
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
