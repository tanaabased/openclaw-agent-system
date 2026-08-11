import assert from 'node:assert/strict';

import createNotificationLifecycleContribution from '../channels/github/lib/lifecycle.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import { AgentSystemLifecycleError } from '../lib/lifecycle-registry.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'data', name: 'Data' },
  github: {
    username: 'data',
    token: 'GH_TOKEN_DATA',
    notifications: {
      approvedActors: [{ login: 'pirog', nodeId: 'U_1' }],
      intervalMinutes: 5,
      repositoryPolicy: { minimumPermission: 'write' },
    },
  },
};
const context = { manifest, workspaceDir: '/workspace/data' };

describe('channels/github/lib/lifecycle', () => {
  it('should always participate so removed manifest state can be cleaned up', () => {
    const contribution = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
    });

    assert.equal(contribution.isConfigured({ schemaVersion: 1, agent: { id: 'data' } }), true);
    assert.equal(
      contribution.validate?.({
        manifest: { schemaVersion: 1, agent: { id: 'data' } },
        workspaceDir: '/workspace/data',
      }),
      undefined,
    );
  });

  it('should validate required github identity and credential declarations', () => {
    const contribution = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
    });
    const invalid: AgentManifest = {
      ...manifest,
      github: {
        notifications: {
          approvedActors: [
            { login: 'pirog', nodeId: 'U_1' },
            { login: 'renamed', nodeId: 'U_1' },
          ],
          intervalMinutes: 5,
          repositoryPolicy: { minimumPermission: 'write' },
        },
      },
    };

    const validation = contribution.validate?.({
      manifest: invalid,
      workspaceDir: '/workspace/data',
    });
    const codes = validation?.diagnostics?.map(({ code }) => code);

    assert.deepEqual(codes, [
      'github-notification-username-required',
      'github-notification-token-required',
      'github-notification-identity-duplicate',
    ]);
  });

  it('should report healthy, drifted, and conflicting routing state', async () => {
    let kind: 'conflict' | 'noop' | 'upsert' = 'noop';
    const contribution = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          return { code: `state-${kind}`, kind, message: kind };
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
    });

    assert.equal((await contribution.inspect?.(context))?.[0]?.status, 'healthy');
    kind = 'upsert';
    assert.equal((await contribution.inspect?.(context))?.[0]?.status, 'drift');
    kind = 'conflict';
    assert.equal((await contribution.inspect?.(context))?.[0]?.status, 'blocked');
  });

  it('should report pending, successful, and deferred monitor observations', async () => {
    const healthyState: GitHubNotificationMonitorState = {
      agentId: 'data',
      baselineItemNodeIds: [],
      failureCount: 0,
      items: {},
      processedEventNodeIds: [],
      schemaVersion: 1,
      workspaceDir: context.workspaceDir,
    };
    const states: Array<GitHubNotificationMonitorState | undefined> = [
      undefined,
      healthyState,
      { ...healthyState, diagnosticCode: 'github-notification-search-truncated' },
    ];
    const contribution = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          return {
            code: 'notification-routing-ready',
            kind: 'noop' as const,
            message: 'ready',
          };
        },
        async reconcile() {
          throw new Error('not used');
        },
      },
      stateStore: { read: async () => states.shift() },
    });

    assert.equal(
      (await contribution.inspect?.(context))?.at(-1)?.code,
      'github-notification-monitor-pending',
    );
    assert.equal(
      (await contribution.inspect?.(context))?.at(-1)?.code,
      'github-notification-monitor-healthy',
    );
    assert.equal(
      (await contribution.inspect?.(context))?.at(-1)?.code,
      'github-notification-search-truncated',
    );
  });

  it('should translate routing reconciliation and preserve attributed failures', async () => {
    const contribution = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          return {
            configChanged: true,
            plan: { code: 'notification-route-installed', kind: 'upsert', message: 'installed' },
            receiptAction: 'created' as const,
            requiresManualRestart: false,
          };
        },
      },
    });
    assert.deepEqual((await contribution.reconcile?.(context))?.outcomes, [
      { code: 'notification-route-installed', message: 'installed', status: 'updated' },
    ]);

    const restartRequired = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          return {
            configChanged: true,
            plan: { code: 'notification-route-installed', kind: 'upsert', message: 'installed' },
            receiptAction: 'created' as const,
            requiresManualRestart: true,
          };
        },
      },
    });
    assert.deepEqual((await restartRequired.reconcile?.(context))?.outcomes, [
      {
        code: 'notification-route-installed',
        message:
          'installed Restart the OpenClaw Gateway to apply this change because gateway.reload.mode is off.',
        status: 'updated',
      },
    ]);

    const failing = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          throw new Error('binding selects another agent');
        },
      },
    });
    await assert.rejects(failing.reconcile!(context), (error: unknown) => {
      assert.equal(error instanceof AgentSystemLifecycleError, true);
      if (error instanceof AgentSystemLifecycleError) {
        assert.equal(error.component, 'github-notifications');
        assert.equal(error.code, 'github-notifications-reconcile-failed');
      }
      return true;
    });
  });

  it('should remove private monitor state only during explicit disabled reconciliation', async () => {
    let removals = 0;
    const contribution = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          return {
            configChanged: false,
            plan: {
              code: 'notification-routing-disabled',
              kind: 'noop' as const,
              message: 'disabled',
            },
            receiptAction: 'none' as const,
            requiresManualRestart: false,
          };
        },
      },
      stateStore: {
        read: async () => undefined,
        remove: async () => {
          removals += 1;
          return true;
        },
      },
    });
    const disabledContext = {
      manifest: { schemaVersion: 1 as const, agent: { id: 'data' } },
      workspaceDir: context.workspaceDir,
    };

    assert.deepEqual((await contribution.reconcile?.(disabledContext))?.outcomes, [
      {
        code: 'github-notification-monitor-state-removed',
        message: 'private GitHub notification monitor state',
        status: 'removed',
      },
    ]);
    assert.equal(removals, 1);
  });
});
