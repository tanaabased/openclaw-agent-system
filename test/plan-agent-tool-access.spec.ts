import assert from 'node:assert/strict';

import planAgentToolAccess, {
  desiredAgentSystemToolGrants,
} from '../utils/plan-agent-tool-access.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const baseManifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'emori', name: 'EMORI' },
};

describe('utils/plan-agent-tool-access', () => {
  it('should derive exact grants from configured capabilities', () => {
    assert.deepEqual(desiredAgentSystemToolGrants(baseManifest), []);
    assert.deepEqual(desiredAgentSystemToolGrants({ ...baseManifest, git: {} }), [
      'agent_system_git',
    ]);
    assert.deepEqual(desiredAgentSystemToolGrants({ ...baseManifest, git: { worktrees: {} } }), [
      'agent_system_git',
      'agent_system_git_worktree',
    ]);
    assert.deepEqual(desiredAgentSystemToolGrants({ ...baseManifest, github: {} }), [
      'agent_system_github',
    ]);
    assert.deepEqual(
      desiredAgentSystemToolGrants({
        ...baseManifest,
        git: { worktrees: {} },
        github: {},
      }),
      ['agent_system_git', 'agent_system_git_worktree', 'agent_system_github'],
    );
  });

  it('should preserve unrelated grants while replacing stale owned grants', () => {
    const plan = planAgentToolAccess(
      { ...baseManifest, git: {} },
      {
        exists: true,
        alsoAllow: ['message', 'agent_system_github'],
      },
    );

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.changed, true);
    assert.deepEqual(plan.missing, ['agent_system_git']);
    assert.deepEqual(plan.stale, ['agent_system_github']);
    assert.deepEqual(plan.next, ['message', 'agent_system_git']);
  });

  it('should use an existing exact allowlist instead of creating alsoAllow', () => {
    const plan = planAgentToolAccess(
      { ...baseManifest, github: {} },
      { exists: true, allow: ['read'] },
    );

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.target, 'allow');
    assert.deepEqual(plan.next, ['read', 'agent_system_github']);
  });

  it('should remain unchanged when every projected grant is present once', () => {
    const current = ['message', 'agent_system_github', 'agent_system_git'];
    const plan = planAgentToolAccess(
      { ...baseManifest, git: {}, github: {} },
      { exists: true, alsoAllow: current },
    );

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.equal(plan.changed, false);
    assert.deepEqual(plan.next, current);
  });

  it('should remove all owned grants when capabilities disappear', () => {
    const plan = planAgentToolAccess(baseManifest, {
      exists: true,
      alsoAllow: [
        'message',
        'agent_system_git',
        'agent_system_git_worktree',
        'agent_system_github',
      ],
    });

    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') return;
    assert.deepEqual(plan.missing, []);
    assert.deepEqual(plan.stale, [
      'agent_system_git',
      'agent_system_git_worktree',
      'agent_system_github',
    ]);
    assert.deepEqual(plan.next, ['message']);
  });

  it('should report an unavailable agent without inventing config state', () => {
    assert.deepEqual(planAgentToolAccess(baseManifest, { exists: false }), {
      status: 'missing-agent',
    });
  });
});
