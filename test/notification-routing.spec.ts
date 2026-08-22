import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import {
  applyNotificationRoutingPlan,
  createNotificationRoutingReceipt,
  githubNotificationChannelId,
  planNotificationRouting,
  resolveNotificationRoute,
  type NotificationRoutingDesiredState,
} from '../channels/github/routing/routing.ts';

const desired: NotificationRoutingDesiredState = {
  agentId: 'data',
  enabled: true,
  workspaceDir: '/workspace/data',
};

function config(): OpenClawConfig {
  return {
    agents: { list: [{ id: 'data', workspace: '/workspace/data' }] },
  };
}

describe('channels/github/routing/routing', () => {
  it('should install and resolve one deterministic account-scoped route', () => {
    const current = config();
    const initial = planNotificationRouting(current, desired);

    assert.equal(initial.kind, 'upsert');
    assert.equal(applyNotificationRoutingPlan(current, desired, initial), true);
    assert.equal(planNotificationRouting(current, desired).kind, 'adopt');

    const receipt = createNotificationRoutingReceipt(desired);
    assert.equal(planNotificationRouting(current, desired, receipt).kind, 'noop');
    const first = resolveNotificationRoute(current, desired, 'github:R_1:12');
    const repeated = resolveNotificationRoute(current, desired, 'github:R_1:12');
    const second = resolveNotificationRoute(current, desired, 'github:R_1:13');

    assert.equal(first.matchedBy, 'binding.account');
    assert.equal(first.agentId, 'data');
    assert.equal(first.workspaceDir, '/workspace/data');
    assert.equal(first.sessionKey, repeated.sessionKey);
    assert.notEqual(first.sessionKey, second.sessionKey);
  });

  it('should preserve unrelated channel accounts and bindings', () => {
    const current: OpenClawConfig = {
      ...config(),
      channels: {
        [githubNotificationChannelId]: {
          accounts: { other: { enabled: true } },
        },
      },
      bindings: [
        {
          type: 'route',
          agentId: 'other',
          match: { channel: githubNotificationChannelId, accountId: 'other' },
        },
        { type: 'route', agentId: 'data', match: { channel: 'slack' } },
      ],
    };

    const install = planNotificationRouting(current, desired);
    assert.equal(install.kind, 'upsert');
    applyNotificationRoutingPlan(current, desired, install);

    const disabled = { ...desired, enabled: false };
    const removal = planNotificationRouting(
      current,
      disabled,
      createNotificationRoutingReceipt(desired),
    );
    assert.equal(removal.kind, 'remove');
    applyNotificationRoutingPlan(current, disabled, removal);

    assert.deepEqual(current.channels, {
      [githubNotificationChannelId]: { accounts: { other: { enabled: true } } },
    });
    assert.deepEqual(current.bindings, [
      {
        type: 'route',
        agentId: 'other',
        match: { channel: githubNotificationChannelId, accountId: 'other' },
      },
      { type: 'route', agentId: 'data', match: { channel: 'slack' } },
    ]);
  });

  it('should reject partial unowned state and conflicting bindings', () => {
    const partial: OpenClawConfig = {
      ...config(),
      channels: {
        [githubNotificationChannelId]: { accounts: { data: { enabled: true } } },
      },
    };
    assert.equal(planNotificationRouting(partial, desired).kind, 'conflict');

    partial.bindings = [
      {
        type: 'route',
        agentId: 'other',
        match: { channel: githubNotificationChannelId, accountId: 'data' },
      },
    ];
    const conflict = planNotificationRouting(partial, desired);
    assert.equal(conflict.kind, 'conflict');
    assert.equal(conflict.code, 'notification-routing-binding-conflict');
  });

  it('should fail closed instead of accepting default-agent routing', () => {
    const current: OpenClawConfig = {
      ...config(),
      channels: {
        [githubNotificationChannelId]: { accounts: { data: { enabled: true } } },
      },
    };

    assert.throws(
      () => resolveNotificationRoute(current, desired, 'github:R_1:12'),
      /exact agent-system-github:data binding/u,
    );
  });

  it('should detect duplicate exact bindings and changed owned cleanup state', () => {
    const current = config();
    const install = planNotificationRouting(current, desired);
    applyNotificationRoutingPlan(current, desired, install);
    current.bindings?.push({ ...current.bindings[0]! });
    assert.equal(
      planNotificationRouting(current, desired, createNotificationRoutingReceipt(desired)).code,
      'notification-routing-binding-duplicate',
    );

    current.bindings = current.bindings?.slice(0, 1);
    current.bindings![0] = {
      type: 'route',
      agentId: 'data',
      match: { channel: githubNotificationChannelId, accountId: 'data' },
      session: { dmScope: 'main' },
    };
    const disabled = { ...desired, enabled: false };
    assert.equal(
      planNotificationRouting(current, disabled, createNotificationRoutingReceipt(desired)).code,
      'notification-routing-binding-changed',
    );
  });
});
