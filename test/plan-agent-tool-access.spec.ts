import assert from 'node:assert/strict';

import planAgentToolAccess, { type AgentToolAccessGrants } from '../api/plan-access.ts';

const owned = ['agent_system_git', 'agent_system_git_worktree', 'agent_system_github'] as const;

function grants(desired: readonly string[]): AgentToolAccessGrants {
  return { desired, owned };
}

describe('api/plan-access', () => {
  it('should preserve unrelated grants while replacing stale owned grants', () => {
    const plan = planAgentToolAccess(grants(['agent_system_git']), {
      exists: true,
      alsoAllow: ['message', 'agent_system_github'],
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.changed, true);
    assert.deepEqual(plan.missing, ['agent_system_git']);
    assert.deepEqual(plan.stale, ['agent_system_github']);
    assert.deepEqual(plan.next, { alsoAllow: ['message', 'agent_system_git'] });
  });

  it('should use an existing exact allowlist and clean the additive allowlist', () => {
    const plan = planAgentToolAccess(grants(['agent_system_github']), {
      exists: true,
      allow: ['read'],
      alsoAllow: ['message', 'agent_system_github', 'agent_system_git'],
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.target, 'allow');
    assert.deepEqual(plan.misplaced, ['agent_system_github']);
    assert.deepEqual(plan.stale, ['agent_system_git']);
    assert.deepEqual(plan.next, {
      allow: ['read', 'agent_system_github'],
      alsoAllow: ['message'],
    });
  });

  it('should remain unchanged when every projected grant is present once', () => {
    const current = ['message', 'agent_system_github', 'agent_system_git'];
    const plan = planAgentToolAccess(grants(['agent_system_git', 'agent_system_github']), {
      exists: true,
      alsoAllow: current,
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.next, { alsoAllow: current });
  });

  it('should remove all owned grants from both allowlists when capabilities disappear', () => {
    const plan = planAgentToolAccess(grants([]), {
      exists: true,
      allow: ['read', 'agent_system_git'],
      alsoAllow: ['message', 'agent_system_git_worktree', 'agent_system_github'],
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.deepEqual(plan.missing, []);
    assert.deepEqual(plan.stale, [...owned]);
    assert.deepEqual(plan.next, { allow: ['read'], alsoAllow: ['message'] });
  });

  it('should collapse duplicate owned grants onto the selected allowlist', () => {
    const plan = planAgentToolAccess(grants(['agent_system_git']), {
      exists: true,
      allow: ['read', 'agent_system_git', 'agent_system_git'],
      alsoAllow: ['message', 'agent_system_git'],
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.changed, true);
    assert.deepEqual(plan.next, {
      allow: ['read', 'agent_system_git'],
      alsoAllow: ['message'],
    });
  });

  it('should report desired grants blocked by exact or wildcard deny entries', () => {
    const plan = planAgentToolAccess(grants(['agent_system_git', 'agent_system_github']), {
      exists: true,
      alsoAllow: ['agent_system_git', 'agent_system_github'],
      deny: ['agent_system_git', 'agent_system_*hub'],
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.deepEqual(plan.denied, ['agent_system_git', 'agent_system_github']);
  });

  it('should report an unavailable agent without inventing config state', () => {
    assert.deepEqual(planAgentToolAccess(grants([]), { exists: false }), {
      status: 'missing-agent',
    });
  });
});
