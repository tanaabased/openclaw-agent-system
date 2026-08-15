import assert from 'node:assert/strict';

import createNotificationLifecycleContribution from '../channels/github/lib/lifecycle.ts';
import decodeGitHubNotificationMonitorState from '../channels/github/utils/monitor-state-codec.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import { AgentSystemLifecycleError } from '../lib/lifecycle-registry.ts';
import type { AgentManifest } from '../utils/manifest-types.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { email: 'data@example.com', id: 'data', name: 'Data' },
  git: { worktrees: {} },
  github: {
    username: 'data',
    token: 'GH_TOKEN_DATA',
    notifications: {
      assignmentTypes: ['issue', 'pull-request'],
      approvedActors: [{ login: 'pirog', nodeId: 'U_1' }],
      intervalMinutes: 5,
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
      agent: { id: 'data' },
      git: undefined,
      github: {
        notifications: {
          assignmentTypes: ['issue', 'pull-request'],
          approvedActors: [
            { login: 'pirog', nodeId: 'U_1' },
            { login: 'renamed', nodeId: 'U_1' },
          ],
          intervalMinutes: 5,
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
      'github-notification-worktrees-required',
      'github-notification-email-required',
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
      baselineAt: 1,
      failureCount: 0,
      items: {},
      lastSuccessfulPollAt: 1,
      processedEventNodeIds: [],
      schemaVersion: 3,
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

  it('should report terminal activation failures without hiding monitor health', async () => {
    const state = notificationMonitorState();
    state.agentId = 'data';
    state.workspaceDir = context.workspaceDir;
    state.lastSuccessfulPollAt = 1;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      acknowledgment: { status: 'pending' },
      activation: {
        failureCode: 'github-notification-planning-response-invalid',
        status: 'failed',
      },
      sessionKey: 'agent:data:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/data/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
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
      stateStore: { read: async () => state },
    });

    const findings = await contribution.inspect?.(context);

    assert.equal(
      findings?.find(({ code }) => code === 'github-notification-planning-response-invalid')
        ?.status,
      'warning',
    );
    assert.equal(findings?.at(-1)?.code, 'github-notification-monitor-healthy');
    assert.deepEqual(state.items[notificationItemKey]?.delivery?.activation, {
      failureCode: 'github-notification-planning-response-invalid',
      status: 'failed',
    });
  });

  it('should ignore terminal activation failures for retired items while retaining history', async () => {
    const state = notificationMonitorState();
    state.agentId = 'data';
    state.workspaceDir = context.workspaceDir;
    state.lastSuccessfulPollAt = 1;
    const item = state.items[notificationItemKey]!;
    item.disposition = 'retired';
    item.reasonCode = 'assignment-no-longer-authorized';
    item.delivery = {
      ...item.delivery!,
      activation: {
        failureCode: 'github-notification-planning-response-invalid',
        status: 'failed',
      },
      stage: 'retired',
    };
    const before = structuredClone(state);
    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
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
      stateStore: { read: async () => state },
    });

    const findings = await contribution.inspect?.(context);

    assert.equal(
      findings?.find(({ code }) => code === 'github-notification-planning-response-invalid'),
      undefined,
    );
    assert.deepEqual(state, before);
  });

  it('should count live activation failures by code without counting retired history', async () => {
    const state = notificationMonitorState();
    state.agentId = 'data';
    state.workspaceDir = context.workspaceDir;
    state.lastSuccessfulPollAt = 1;
    const item = state.items[notificationItemKey]!;
    item.assignmentEventNodeId = 'EV_assignment_live_1';
    item.delivery = {
      ...item.delivery!,
      acknowledgment: { status: 'pending' },
      activation: {
        failureCode: 'github-notification-planning-response-invalid',
        status: 'failed',
      },
      assignmentEventId: 'EV_assignment_live_1',
      sessionKey: 'agent:data:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      workId: 'issue-7',
      worktreeBranch: 'agent/data/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    state.items['github:R_repo:13'] = {
      ...item,
      assignmentEventNodeId: 'EV_assignment_live_2',
      itemDatabaseId: 8,
      itemNodeId: 'I_item_2',
      number: 13,
      delivery: {
        ...item.delivery!,
        assignmentEventId: 'EV_assignment_live_2',
        activation: {
          failureCode: 'github-notification-planning-response-invalid',
          status: 'failed',
        },
        sessionKey: 'agent:data:agent-system-github:direct:github:R_repo:13',
        workId: 'issue-8',
        worktreeBranch: 'agent/data/issue-8',
        worktreePath: '/workspace/worktrees/issue-8',
      },
    };
    state.items['github:R_repo:15'] = {
      ...item,
      assignmentEventNodeId: 'EV_assignment_live_3',
      itemDatabaseId: 10,
      itemNodeId: 'I_item_4',
      number: 15,
      delivery: {
        ...item.delivery!,
        assignmentEventId: 'EV_assignment_live_3',
        activation: {
          failureCode: 'github-notification-planning-response-missing',
          status: 'failed',
        },
        sessionKey: 'agent:data:agent-system-github:direct:github:R_repo:15',
        workId: 'issue-10',
        worktreeBranch: 'agent/data/issue-10',
        worktreePath: '/workspace/worktrees/issue-10',
      },
    };
    state.items['github:R_repo:14'] = {
      ...item,
      assignmentEventNodeId: 'EV_assignment_retired_1',
      disposition: 'retired',
      itemDatabaseId: 9,
      itemNodeId: 'I_item_3',
      number: 14,
      reasonCode: 'assignment-no-longer-authorized',
      delivery: {
        ...item.delivery!,
        acknowledgment: { status: 'pending' },
        activation: {
          failureCode: 'github-notification-planning-response-missing',
          status: 'failed',
        },
        assignmentEventId: 'EV_assignment_retired_1',
        sessionKey: 'agent:data:agent-system-github:direct:github:R_repo:14',
        stage: 'retired',
        workId: 'issue-9',
        worktreeBranch: 'agent/data/issue-9',
        worktreePath: '/workspace/worktrees/issue-9',
      },
    };
    const before = structuredClone(state);
    assert.equal(decodeGitHubNotificationMonitorState(state, state.agentId)?.status, 'ready');
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
      stateStore: { read: async () => state },
    });

    const findings = await contribution.inspect?.(context);

    assert.match(
      findings?.find(({ code }) => code === 'github-notification-planning-response-invalid')
        ?.message ?? '',
      /2 GitHub notification activations failed/,
    );
    assert.match(
      findings?.find(({ code }) => code === 'github-notification-planning-response-missing')
        ?.message ?? '',
      /1 GitHub notification activation failed/,
    );
    assert.deepEqual(state, before);
  });

  it('should report pending and failed acknowledgments without hiding monitor health', async () => {
    const state = notificationMonitorState();
    state.agentId = 'data';
    state.workspaceDir = context.workspaceDir;
    state.lastSuccessfulPollAt = 1;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      acknowledgment: { status: 'pending' },
      activation: { status: 'adopted' },
      sessionKey: 'agent:data:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/data/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
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
      stateStore: { read: async () => state },
    });

    let findings = await contribution.inspect?.(context);

    assert.equal(
      findings?.find(({ code }) => code === 'github-notification-acknowledgment-pending')?.status,
      'warning',
    );
    item.delivery.acknowledgment = {
      failureCode: 'github-notification-acknowledgment-not-confirmed',
      status: 'failed',
    };
    item.delivery.activation = { status: 'planned' };
    findings = await contribution.inspect?.(context);
    assert.equal(
      findings?.find(({ code }) => code === 'github-notification-acknowledgment-not-confirmed')
        ?.status,
      'warning',
    );
    assert.equal(findings?.at(-1)?.code, 'github-notification-monitor-healthy');
  });

  it('should report comment baseline, dispatch, and reply diagnostics separately from monitor health', async () => {
    const state = notificationMonitorState();
    state.agentId = 'data';
    state.workspaceDir = context.workspaceDir;
    state.lastSuccessfulPollAt = 1;
    const item = state.items[notificationItemKey]!;
    item.delivery = {
      ...item.delivery!,
      acknowledgment: { commentId: 90, status: 'published' },
      activation: { status: 'planned' },
      sessionKey: 'agent:data:agent-system-github:direct:github:R_repo:12',
      stage: 'active',
      worktreeBranch: 'agent/data/issue-7',
      worktreePath: '/workspace/worktrees/issue-7',
    };
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
      stateStore: { read: async () => state },
    });

    let findings = await contribution.inspect?.(context);
    assert.equal(
      findings?.find(({ code }) => code === 'github-notification-comment-baseline-pending')?.status,
      'warning',
    );

    item.commentTracking = {
      baselineAt: 2,
      diagnosticCode: 'github-notification-comments-truncated',
      revisions: {
        IC_failed: {
          actorNodeId: 'U_actor',
          bodyDigest: 'a'.repeat(64),
          commentDatabaseId: 91,
          commentNodeId: 'IC_failed',
          createdAt: 2,
          disposition: 'approved',
          reasonCode: 'comment-approved',
          revisionId: 'b'.repeat(64),
          turn: {
            failureCode: 'github-notification-comment-dispatch-failed',
            status: 'failed',
          },
          updatedAt: 2,
        },
        IC_reply_failed: {
          actorNodeId: 'U_actor',
          bodyDigest: 'c'.repeat(64),
          commentDatabaseId: 92,
          commentNodeId: 'IC_reply_failed',
          createdAt: 3,
          disposition: 'approved',
          reasonCode: 'comment-approved',
          reply: {
            failureCode: 'github-notification-reply-not-confirmed',
            status: 'failed',
          },
          revisionId: 'd'.repeat(64),
          turn: { status: 'responded' },
          updatedAt: 3,
        },
      },
    };
    findings = await contribution.inspect?.(context);
    assert.equal(
      findings?.find(({ code }) => code === 'github-notification-comments-truncated')?.status,
      'warning',
    );
    assert.equal(
      findings?.find(({ code }) => code === 'github-notification-comment-dispatch-failed')?.status,
      'warning',
    );
    assert.equal(
      findings?.find(({ code }) => code === 'github-notification-reply-not-confirmed')?.status,
      'warning',
    );
    assert.equal(findings?.at(-1)?.code, 'github-notification-monitor-healthy');
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

  it('should establish the first baseline before enabled installation completes', async () => {
    const refreshes: Array<{
      agentId?: string;
      bypassInterval?: boolean;
      waitForLeaseMs?: number;
    }> = [];
    const contribution = createNotificationLifecycleContribution({
      monitorService: {
        async runOnce(options) {
          refreshes.push(options && 'aborted' in options ? {} : (options ?? {}));
          return [
            {
              agentId: 'data',
              baseline: 0,
              baselineAt: 1_000,
              baselineEstablished: true,
              code: 'github-notification-baseline-established',
              status: 'completed' as const,
            },
          ];
        },
      },
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          return {
            configChanged: true,
            plan: {
              code: 'notification-route-installed',
              kind: 'upsert' as const,
              message: 'installed',
            },
            receiptAction: 'created' as const,
            requiresManualRestart: false,
          };
        },
      },
      stateStore: { read: async () => undefined },
    });

    assert.deepEqual(await contribution.reconcile?.(context), {
      outcomes: [
        { code: 'notification-route-installed', message: 'installed', status: 'updated' },
        {
          code: 'github-notification-baseline-established',
          message: 'GitHub notification baseline established with 0 existing assignments.',
          status: 'created',
        },
      ],
      warnings: [],
    });
    assert.deepEqual(refreshes, [
      { agentId: 'data', bypassInterval: true, waitForLeaseMs: 120_000 },
    ]);
  });

  it('should fail enabled installation when the first baseline cannot be established', async () => {
    const contribution = createNotificationLifecycleContribution({
      monitorService: {
        async runOnce() {
          return [
            {
              agentId: 'data',
              code: 'github-notification-provider-failed',
              diagnosticCode: 'github-notification-provider-failed',
              retryAt: 61_000,
              status: 'failed' as const,
            },
          ];
        },
      },
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          return {
            configChanged: true,
            plan: {
              code: 'notification-route-installed',
              kind: 'upsert' as const,
              message: 'installed',
            },
            receiptAction: 'created' as const,
            requiresManualRestart: false,
          };
        },
      },
      stateStore: { read: async () => undefined },
    });

    await assert.rejects(contribution.reconcile!(context), (error: unknown) => {
      assert.equal(error instanceof AgentSystemLifecycleError, true);
      if (error instanceof AgentSystemLifecycleError) {
        assert.equal(error.component, 'github-notifications');
        assert.equal(error.code, 'github-notification-baseline-failed');
        assert.match(error.message, /code=github-notification-provider-failed/);
        assert.match(error.message, /1970-01-01T00:01:01.000Z/);
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

  it('should retain disabled monitor state while local session retirement is pending', async () => {
    let removals = 0;
    const state = notificationMonitorState();
    const delivery = state.items[notificationItemKey]?.delivery;
    assert.ok(delivery);
    state.items[notificationItemKey]!.delivery = {
      ...delivery,
      activation: { status: 'planned' },
      sessionId: 'session-1',
      sessionKey: 'agent:data:github:item',
      stage: 'active',
      worktreeBranch: 'issue-7-branch',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    const contribution = createNotificationLifecycleContribution({
      routingService: {
        async inspect() {
          return {
            code: 'notification-routing-disabled',
            kind: 'noop' as const,
            message: 'disabled',
          };
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
        read: async () => state,
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

    assert.deepEqual(await contribution.inspect?.(disabledContext), [
      {
        code: 'github-notification-retirement-pending',
        message: 'GitHub notification sessions are still retiring locally.',
        remediation: 'Keep the OpenClaw Gateway running until retirement completes.',
        status: 'warning',
      },
    ]);
    assert.deepEqual(await contribution.reconcile?.(disabledContext), {
      outcomes: [],
      warnings: [
        {
          code: 'github-notification-retirement-pending',
          message: 'GitHub notification state was retained until the Gateway retires its sessions.',
        },
      ],
    });
    assert.equal(removals, 0);
  });

  it('should retire disabled assignments before removing private monitor state', async () => {
    const state = notificationMonitorState();
    const delivery = state.items[notificationItemKey]?.delivery;
    assert.ok(delivery);
    state.items[notificationItemKey]!.delivery = {
      ...delivery,
      activation: { status: 'planned' },
      sessionId: 'session-1',
      sessionKey: 'agent:data:github:item',
      stage: 'active',
      worktreeBranch: 'issue-7-branch',
      worktreePath: '/workspace/worktrees/issue-7',
    };
    let current: GitHubNotificationMonitorState | undefined = state;
    let removals = 0;
    const refreshes: Array<{
      agentId?: string;
      bypassInterval?: boolean;
      waitForLeaseMs?: number;
    }> = [];
    const contribution = createNotificationLifecycleContribution({
      monitorService: {
        async runOnce(options) {
          refreshes.push(options && 'aborted' in options ? {} : (options ?? {}));
          current = undefined;
          return [
            {
              agentId: 'data',
              code: 'github-notification-disabled',
              status: 'skipped' as const,
            },
          ];
        },
      },
      routingService: {
        async inspect() {
          throw new Error('not used');
        },
        async reconcile() {
          return {
            configChanged: true,
            plan: {
              code: 'notification-route-removed',
              kind: 'remove' as const,
              message: 'removed',
            },
            receiptAction: 'removed' as const,
            requiresManualRestart: false,
          };
        },
      },
      stateStore: {
        read: async () => current,
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

    assert.deepEqual(await contribution.reconcile?.(disabledContext), {
      outcomes: [
        { code: 'notification-route-removed', message: 'removed', status: 'removed' },
        {
          code: 'github-notification-monitor-state-removed',
          message: 'private GitHub notification monitor state',
          status: 'removed',
        },
      ],
      warnings: [],
    });
    assert.deepEqual(refreshes, [
      { agentId: 'data', bypassInterval: true, waitForLeaseMs: 120_000 },
    ]);
    assert.equal(removals, 0);
  });
});
