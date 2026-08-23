import assert from 'node:assert/strict';

import planAgentInstall from '../agent/plan-install.ts';

const desired = {
  agentId: 'data',
  workspaceDir: '/workspace/data',
  identity: { name: 'Data', avatar: 'avatar.png', emoji: '📊' },
};

describe('agent/plan-install', () => {
  it('should add and identify an absent agent', () => {
    const plan = planAgentInstall(desired, { exists: false });

    assert.deepEqual(plan, {
      status: 'ready',
      agentId: 'data',
      actions: ['add-agent', 'set-identity'],
      workspaceDir: '/workspace/data',
    });
  });

  it('should leave a matching agent unchanged', () => {
    const plan = planAgentInstall(desired, {
      exists: true,
      workspaceDir: '/workspace/data',
      identity: { name: 'Data', avatar: 'avatar.png', emoji: '📊' },
    });

    assert.equal(plan.status, 'ready');
    if (plan.status === 'ready') assert.deepEqual(plan.actions, []);
  });

  it('should preserve undeclared optional identity fields', () => {
    const plan = planAgentInstall(
      { ...desired, identity: { name: 'Data' } },
      {
        exists: true,
        workspaceDir: '/workspace/data',
        identity: { name: 'Data', avatar: 'existing.png', emoji: '🤖' },
      },
    );

    assert.equal(plan.status, 'ready');
    if (plan.status === 'ready') assert.deepEqual(plan.actions, []);
  });

  it('should reconcile manifest-owned identity drift', () => {
    const plan = planAgentInstall(desired, {
      exists: true,
      workspaceDir: '/workspace/data',
      identity: { name: 'Other', avatar: 'other.png', emoji: '🤖' },
    });

    assert.equal(plan.status, 'ready');
    if (plan.status === 'ready') assert.deepEqual(plan.actions, ['set-identity']);
  });

  it('should reconcile manifest-owned emoji drift', () => {
    const plan = planAgentInstall(desired, {
      exists: true,
      workspaceDir: '/workspace/data',
      identity: { name: 'Data', avatar: 'avatar.png', emoji: '🤖' },
    });

    assert.equal(plan.status, 'ready');
    if (plan.status === 'ready') assert.deepEqual(plan.actions, ['set-identity']);
  });

  it('should reject an existing agent bound to another workspace', () => {
    assert.deepEqual(
      planAgentInstall(desired, {
        exists: true,
        workspaceDir: '/workspace/other',
        identity: { name: 'Data', avatar: 'avatar.png', emoji: '📊' },
      }),
      {
        status: 'conflict',
        agentId: 'data',
        configuredWorkspaceDir: '/workspace/other',
        desiredWorkspaceDir: '/workspace/data',
      },
    );
  });
});
