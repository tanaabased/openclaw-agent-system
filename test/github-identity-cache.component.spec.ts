import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import decode from '../channels/github/v3-config-schema.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';
import type { GitHubIdentity } from '../channels/github/provider/work-item.ts';

describe('channels/github/identity-cache', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'github-identities-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const policy = () =>
    decode({
      'schema-version': 3,
      'allowed-repository-owners': ['@owner'],
      'issue-assignment': {
        allowed: ['@actor', 'U_actor'],
        reviewers: [{ name: 'reviewer', 'node-id': 'U_reviewer' }],
      },
    });
  const owner = { login: 'owner', nodeId: 'O_owner', type: 'Organization' };
  const actor = { login: 'actor', nodeId: 'U_actor', type: 'User' };
  const reviewer = { login: 'reviewer', nodeId: 'U_reviewer', type: 'User' };
  const resolveIdentity = async (reference: string): Promise<GitHubIdentity> => {
    const result = [owner, actor, reviewer].find(
      (pin) => reference === '@' + pin.login || reference === pin.nodeId,
    );
    if (!result) throw new Error('github-identity-unresolved');
    return { ...result };
  };

  it('should resolve mixed forms into equivalent authority and read pins without network', async () => {
    const cache = new GitHubIdentityCache({ root, scope: 'test' });
    const input = policy();
    await cache.resolve(input, { resolveIdentity });
    assert.deepEqual(
      feedbackIdentities(input.issueAssignment!.allowed, input.issueAssignment!.feedback),
      [
        { login: actor.login, nodeId: actor.nodeId },
        { login: reviewer.login, nodeId: reviewer.nodeId },
      ],
    );
    const fresh = policy();
    await new GitHubIdentityCache({ root, scope: 'test' }).hydrate(fresh);
    assert.equal(fresh.issueAssignment!.allowed[0]!.nodeId, actor.nodeId);
    assert.equal(fresh.issueAssignment!.allowed[1]!.login, actor.login);
  });

  it('should follow a pinned immutable identity across rename without granting its old name to a new account', async () => {
    await new GitHubIdentityCache({ root, scope: 'test' }).resolve(policy(), { resolveIdentity });
    const requests: string[] = [];
    const fresh = policy();
    await new GitHubIdentityCache({ root, scope: 'test' }).resolve(fresh, {
      resolveIdentity: async (reference) => {
        requests.push(reference);
        if (reference === 'U_actor') return { ...actor, login: 'renamed' };
        if (reference === '@actor') return { ...actor, nodeId: 'U_replacement' };
        return resolveIdentity(reference);
      },
    });
    assert.equal(requests.includes('@actor'), false);
    assert.equal(fresh.issueAssignment!.allowed[0]!.nodeId, 'U_actor');
    assert.equal(fresh.issueAssignment!.allowed[0]!.login, 'renamed');
  });

  it('should reuse identity reads within one connection and refresh them for a new operation', async () => {
    const requests: string[] = [];
    const client = {
      resolveIdentity: async (reference: string) => {
        requests.push(reference);
        return resolveIdentity(reference);
      },
    };
    const location = { root, scope: 'operation' };
    await new GitHubIdentityCache(location).resolve(policy(), client);
    const first = requests.length;
    await new GitHubIdentityCache(location).resolve(policy(), client);
    assert.equal(requests.length, first);
    const changed = decode({
      'schema-version': 3,
      'allowed-repository-owners': ['@owner'],
      'issue-assignment': { allowed: ['@owner'] },
    });
    await assert.rejects(
      new GitHubIdentityCache(location).resolve(changed, client),
      /github-identity-type-invalid/,
    );
    const next = policy();
    await new GitHubIdentityCache(location).resolve(next, {
      resolveIdentity: async (reference) => {
        requests.push(reference);
        const identity = await resolveIdentity(reference);
        return identity.nodeId === actor.nodeId ? { ...identity, login: 'renamed' } : identity;
      },
    });
    assert.ok(requests.length > first);
    assert.equal(next.issueAssignment!.allowed[0]!.login, 'renamed');
    const beforeOther = requests.length;
    await new GitHubIdentityCache({ root, scope: 'other-workspace' }).resolve(policy(), client);
    assert.equal(requests.length, beforeOther + first);
  });

  it('should reject mismatched pins, inappropriate types and unresolved compact inputs', async () => {
    for (const identity of [
      { ...actor, type: 'Organization' },
      { ...actor, nodeId: 'U_other', login: 'other' },
    ]) {
      const input = decode({
        'schema-version': 3,
        'allowed-repository-owners': ['@owner'],
        'issue-assignment': { allowed: [{ login: 'actor', 'node-id': 'U_actor' }] },
      });
      await assert.rejects(
        new GitHubIdentityCache({ root, scope: 'test' }).resolve(input, {
          resolveIdentity: async (reference) =>
            reference === '@owner' || reference === 'O_owner' ? owner : identity,
        }),
        /github-identity-(type-invalid|conflict)/,
      );
    }
    await assert.rejects(
      new GitHubIdentityCache({ root, scope: 'test' }).resolve(policy(), {}),
      /resolution-unavailable/,
    );
  });

  it('should retain verified pins through partial failure and avoid resolving reviewers for intake', async () => {
    const input = policy();
    const cache = new GitHubIdentityCache({ root, scope: 'test' });
    await cache.resolve(
      input,
      {
        resolveIdentity: async (reference) => {
          if (reference === 'U_reviewer') throw new Error('provider-offline');
          return resolveIdentity(reference);
        },
      },
      'assignment',
    );
    await assert.rejects(
      cache.resolve(input, {
        resolveIdentity: async () => {
          throw new Error('provider-offline');
        },
      }),
      /provider-offline/,
    );
    const fresh = policy();
    await new GitHubIdentityCache({ root, scope: 'test' }).hydrate(fresh);
    assert.equal(fresh.issueAssignment!.allowed[0]!.nodeId, 'U_actor');
    assert.equal(fresh.issueAssignment!.allowed.length, 2);
  });

  it('should allow concurrent lookups without transferring a name pinned during the lookup', async () => {
    for (const conflict of [false, true]) {
      const location = { root, scope: conflict ? 'conflict' : 'matching' };
      const input = () => decode({ 'schema-version': 3, 'allowed-repository-owners': ['@actor'] });
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const slow = new GitHubIdentityCache(location).resolve(input(), {
        resolveIdentity: async () => {
          started.resolve();
          await release.promise;
          return conflict ? { ...actor, nodeId: 'U_replacement' } : actor;
        },
      });
      const outcome = slow.then(
        () => undefined,
        (error: unknown) => error,
      );
      await started.promise;
      try {
        await new GitHubIdentityCache(location).resolve(input(), { resolveIdentity });
        assert.equal(
          (await new GitHubIdentityCache(location).read()).entries['@actor']?.nodeId,
          actor.nodeId,
        );
      } finally {
        release.resolve();
      }
      const error = await outcome;
      if (conflict) assert.match(String(error), /github-identity-conflict/);
      else assert.equal(error, undefined);
      assert.equal(
        (await new GitHubIdentityCache(location).read()).entries['@actor']?.nodeId,
        actor.nodeId,
      );
    }
  });
});
