import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import NotificationRoutingService from '../lib/notification-routing-service.ts';
import type {
  NotificationRoutingDesiredState,
  NotificationRoutingReceipt,
} from '../utils/notification-routing.ts';

const desired: NotificationRoutingDesiredState = {
  agentId: 'data',
  enabled: true,
  workspaceDir: '/workspace/data',
};

describe('lib/notification-routing-service', () => {
  it('should reconcile idempotently and remove only owned state', async () => {
    const config: OpenClawConfig = {
      agents: { list: [{ id: 'data', workspace: '/workspace/data' }] },
      bindings: [{ type: 'route', agentId: 'data', match: { channel: 'slack' } }],
      channels: { slack: { enabled: true } },
    };
    let receipt: NotificationRoutingReceipt | undefined;
    let mutations = 0;
    const service = new NotificationRoutingService({
      async mutateConfigFile({ mutate }) {
        mutations += 1;
        return { result: mutate(config) === true };
      },
      readConfig: () => config,
      receiptStore: {
        async read() {
          return receipt;
        },
        async remove() {
          const removed = receipt !== undefined;
          receipt = undefined;
          return removed;
        },
        async write(nextReceipt) {
          receipt = nextReceipt;
        },
      },
    });

    const first = await service.reconcile(desired);
    const second = await service.reconcile(desired);

    assert.equal(first.plan.kind, 'upsert');
    assert.equal(first.configChanged, true);
    assert.equal(first.receiptAction, 'created');
    assert.equal(second.plan.kind, 'noop');
    assert.equal(second.configChanged, false);
    assert.equal(second.receiptAction, 'none');
    assert.equal(mutations, 1);

    const removed = await service.reconcile({ ...desired, enabled: false });
    assert.equal(removed.plan.kind, 'remove');
    assert.equal(removed.receiptAction, 'removed');
    assert.equal(receipt, undefined);
    assert.deepEqual(config.channels, { slack: { enabled: true } });
    assert.deepEqual(config.bindings, [
      { type: 'route', agentId: 'data', match: { channel: 'slack' } },
    ]);
  });

  it('should adopt only an exact route and reject a route owned by another agent', async () => {
    const config: OpenClawConfig = {
      agents: { list: [{ id: 'data', workspace: '/workspace/data' }] },
      channels: {
        'agent-system-github': { accounts: { data: { enabled: true } } },
      },
      bindings: [
        {
          type: 'route',
          agentId: 'data',
          match: { channel: 'agent-system-github', accountId: 'data' },
          session: { dmScope: 'per-account-channel-peer' },
        },
      ],
    };
    let receipt: NotificationRoutingReceipt | undefined;
    const service = new NotificationRoutingService({
      async mutateConfigFile({ mutate }) {
        return { result: mutate(config) === true };
      },
      readConfig: () => config,
      receiptStore: {
        async read() {
          return receipt;
        },
        async remove() {
          receipt = undefined;
          return true;
        },
        async write(nextReceipt) {
          receipt = nextReceipt;
        },
      },
    });

    assert.equal((await service.reconcile(desired)).plan.kind, 'adopt');
    assert.equal(receipt?.agentId, 'data');

    receipt = undefined;
    config.bindings![0]!.agentId = 'other';
    await assert.rejects(service.reconcile(desired), /selects another agent/u);
  });
});
