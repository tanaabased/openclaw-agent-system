import type { AgentManifest, ManifestDiagnostic } from '../../../utils/manifest-types.ts';
import type { NotificationRoutingDesiredState } from '../utils/routing.ts';
import { githubNotificationRetirementItemKeys } from '../utils/monitor-state.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleContext,
} from '../../../lib/lifecycle-registry.ts';
import type NotificationRoutingService from './routing-service.ts';
import type GitHubNotificationMonitorService from './monitor-service.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';

const notificationLifecycleLeaseWaitMs = 120_000;

export interface NotificationLifecycleDependencies {
  monitorService?: Pick<GitHubNotificationMonitorService, 'runOnce'>;
  routingService: Pick<NotificationRoutingService, 'inspect' | 'reconcile'>;
  stateStore?: Pick<GitHubNotificationMonitorStateStore, 'read'> &
    Partial<Pick<GitHubNotificationMonitorStateStore, 'remove'>>;
}

function isoTime(value: number | undefined): string {
  return value === undefined ? 'unknown' : new Date(value).toISOString();
}

function desiredState(context: AgentSystemLifecycleContext): NotificationRoutingDesiredState {
  return {
    agentId: context.manifest.agent.id,
    enabled: context.manifest.github?.notifications !== undefined,
    workspaceDir: context.workspaceDir,
  };
}

function duplicateIdentityDiagnostics(
  manifest: AgentManifest,
  field: 'approvedActors' | 'allowedRepositoryOwners',
  fieldPath: string,
): ManifestDiagnostic[] {
  const notifications = manifest.github?.notifications;
  const identities =
    field === 'approvedActors'
      ? notifications?.approvedActors
      : notifications?.allowedRepositoryOwners;
  if (!identities) return [];
  const seen = new Set<string>();
  const diagnostics: ManifestDiagnostic[] = [];
  identities.forEach(({ nodeId }, index) => {
    if (seen.has(nodeId)) {
      diagnostics.push({
        code: 'github-notification-identity-duplicate',
        fieldPath: `${fieldPath}/${index}/node-id`,
        message: 'GitHub notification identity node ids must be unique within each list.',
        severity: 'error',
      });
    }
    seen.add(nodeId);
  });
  return diagnostics;
}

function validateNotifications(manifest: AgentManifest): ManifestDiagnostic[] {
  if (!manifest.github?.notifications) return [];
  const diagnostics: ManifestDiagnostic[] = [];
  if (manifest.github.username === undefined) {
    diagnostics.push({
      code: 'github-notification-username-required',
      fieldPath: '/github/username',
      message: 'GitHub notifications require the agent GitHub username.',
      severity: 'error',
    });
  }
  if (manifest.github.token === undefined) {
    diagnostics.push({
      code: 'github-notification-token-required',
      fieldPath: '/github/token',
      message: 'GitHub notifications require an environment-bound GitHub token.',
      severity: 'error',
    });
  }
  if (manifest.git?.worktrees === undefined) {
    diagnostics.push({
      code: 'github-notification-worktrees-required',
      fieldPath: '/git/worktrees',
      message: 'GitHub notifications require deterministic Git worktrees.',
      severity: 'error',
    });
  }
  if (manifest.agent.email === undefined && manifest.git?.email === undefined) {
    diagnostics.push({
      code: 'github-notification-email-required',
      fieldPath: '/agent/email',
      message: 'GitHub notifications require an agent or Git author email.',
      severity: 'error',
    });
  }
  diagnostics.push(
    ...duplicateIdentityDiagnostics(
      manifest,
      'approvedActors',
      '/github/notifications/approved-actors',
    ),
    ...duplicateIdentityDiagnostics(
      manifest,
      'allowedRepositoryOwners',
      '/github/notifications/allowed-repository-owners',
    ),
  );
  return diagnostics;
}

/** Own the manifest-to-global OpenClaw route required by GitHub notifications. */
export default function createNotificationLifecycleContribution(
  dependencies: NotificationLifecycleDependencies,
): AgentSystemLifecycleContribution {
  return {
    id: 'github-notifications',
    // Cleanup remains discoverable after github.notifications is removed.
    isConfigured: () => true,
    validate({ manifest }) {
      if (!manifest.github?.notifications) return undefined;
      return {
        code: 'github-notifications-declaration-valid',
        diagnostics: validateNotifications(manifest),
        summary: 'GitHub notification declaration',
      };
    },
    async inspect(context) {
      const plan = await dependencies.routingService.inspect(desiredState(context));
      if (plan.kind === 'noop' && plan.code === 'notification-routing-disabled') {
        const state = await dependencies.stateStore?.read(context.manifest.agent.id);
        return githubNotificationRetirementItemKeys(state).length > 0
          ? [
              {
                code: 'github-notification-retirement-pending',
                message: 'GitHub notification sessions are still retiring locally.',
                remediation: 'Keep the OpenClaw Gateway running until retirement completes.',
                status: 'warning' as const,
              },
            ]
          : [];
      }
      const routingFinding = [
        {
          code: plan.code,
          message: plan.message,
          remediation:
            plan.kind === 'noop'
              ? undefined
              : 'Run openclaw agent-system install from the agent workspace.',
          status:
            plan.kind === 'conflict'
              ? ('blocked' as const)
              : plan.kind === 'noop'
                ? ('healthy' as const)
                : ('drift' as const),
        },
      ];
      if (plan.kind !== 'noop' || plan.code !== 'notification-routing-ready') {
        return routingFinding;
      }
      if (!dependencies.stateStore) return routingFinding;
      const state = await dependencies.stateStore.read(context.manifest.agent.id);
      if (!state) {
        return [
          ...routingFinding,
          {
            code: 'github-notification-monitor-pending',
            message: 'The GitHub notification monitor has not completed its first observation.',
            status: 'warning' as const,
          },
        ];
      }
      if (state.workspaceDir !== context.workspaceDir) {
        return [
          ...routingFinding,
          {
            code: 'github-notification-state-scope-mismatch',
            message: 'The GitHub notification monitor state belongs to another workspace.',
            remediation: 'Correct the private monitor state before restarting the Gateway.',
            status: 'blocked' as const,
          },
        ];
      }
      if (state.diagnosticCode) {
        return [
          ...routingFinding,
          {
            code: state.diagnosticCode,
            message: `The GitHub notification monitor is waiting after ${state.diagnosticCode}; next retry is ${isoTime(state.nextPollAt)}.`,
            remediation:
              'Resolve the named diagnostic, then run openclaw agent-system notifications refresh.',
            status: 'warning' as const,
          },
        ];
      }
      if (state.baselineAt === undefined || state.lastSuccessfulPollAt === undefined) {
        return [
          ...routingFinding,
          {
            code: 'github-notification-monitor-pending',
            message: 'The GitHub notification monitor has not completed its first observation.',
            remediation: 'Run openclaw agent-system notifications refresh.',
            status: 'warning' as const,
          },
        ];
      }
      const activationFailureCounts = new Map<string, number>();
      const acknowledgmentFailureCounts = new Map<string, number>();
      const commentDiagnosticCounts = new Map<string, number>();
      const commentDispatchFailureCounts = new Map<string, number>();
      const commentReplyFailureCounts = new Map<string, number>();
      let acknowledgmentPendingCount = 0;
      let commentBaselinePendingCount = 0;
      let commentResponsePendingCount = 0;
      for (const item of Object.values(state.items)) {
        const delivery = item.delivery;
        const activation = delivery?.activation;
        if (item.disposition !== 'approved' || activation?.status !== 'failed') continue;
        const code = activation.failureCode ?? 'github-notification-activation-failed';
        activationFailureCounts.set(code, (activationFailureCounts.get(code) ?? 0) + 1);
      }
      for (const item of Object.values(state.items)) {
        const delivery = item.delivery;
        if (item.disposition !== 'approved' || delivery?.stage !== 'active') continue;
        const acknowledgment = delivery.acknowledgment;
        if (acknowledgment?.status === 'pending') {
          acknowledgmentPendingCount += 1;
        } else if (acknowledgment?.status === 'failed') {
          acknowledgmentFailureCounts.set(
            acknowledgment.failureCode,
            (acknowledgmentFailureCounts.get(acknowledgment.failureCode) ?? 0) + 1,
          );
        }
      }
      for (const item of Object.values(state.items)) {
        const delivery = item.delivery;
        if (
          item.disposition !== 'approved' ||
          item.itemType !== 'issue' ||
          delivery?.stage !== 'active'
        ) {
          continue;
        }
        const tracking = item.commentTracking;
        if (tracking?.baselineAt === undefined) commentBaselinePendingCount += 1;
        if (tracking?.diagnosticCode) {
          commentDiagnosticCounts.set(
            tracking.diagnosticCode,
            (commentDiagnosticCounts.get(tracking.diagnosticCode) ?? 0) + 1,
          );
        }
        for (const comment of Object.values(tracking?.revisions ?? {})) {
          if (comment.disposition !== 'approved') continue;
          if (comment.turn?.status === 'pending' || comment.turn?.status === 'adopted') {
            commentResponsePendingCount += 1;
          } else if (comment.turn?.status === 'failed') {
            const code = comment.turn.failureCode ?? 'github-notification-comment-dispatch-failed';
            commentDispatchFailureCounts.set(
              code,
              (commentDispatchFailureCounts.get(code) ?? 0) + 1,
            );
          } else if (comment.reply?.status === 'failed') {
            commentReplyFailureCounts.set(
              comment.reply.failureCode,
              (commentReplyFailureCounts.get(comment.reply.failureCode) ?? 0) + 1,
            );
          }
        }
      }
      const activationFindings = [...activationFailureCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({
          code,
          message: `${count} GitHub notification activation${count === 1 ? '' : 's'} failed after OpenClaw adopted the planning turn.`,
          remediation: 'Resolve the named diagnostic, then use a fresh assignment.',
          status: 'warning' as const,
        }));
      const acknowledgmentFindings = [...acknowledgmentFailureCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({
          code,
          message: `${count} GitHub notification acknowledgment${count === 1 ? '' : 's'} failed after the private planning turn completed.`,
          remediation:
            'The private plan remains available. Resolve the named diagnostic; automatic acknowledgment replay is not currently supported.',
          status: 'warning' as const,
        }));
      const acknowledgmentPendingFindings =
        acknowledgmentPendingCount === 0
          ? []
          : [
              {
                code: 'github-notification-acknowledgment-pending',
                message: `${acknowledgmentPendingCount} GitHub notification acknowledgment${acknowledgmentPendingCount === 1 ? ' is waiting for its' : 's are waiting for their'} planning or publication checkpoint.`,
                remediation:
                  'Wait for Gateway activation to settle; if this persists, inspect the Gateway logs and use a fresh assignment.',
                status: 'warning' as const,
              },
            ];
      const commentDiagnosticFindings = [...commentDiagnosticCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({
          code,
          message: `${count} GitHub issue conversation${count === 1 ? '' : 's'} could not advance comment tracking safely.`,
          remediation:
            'Reduce the comment history below the bounded pagination limit, then run openclaw agent-system notifications refresh.',
          status: 'warning' as const,
        }));
      const commentDispatchFindings = [...commentDispatchFailureCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({
          code,
          message: `${count} GitHub comment response turn${count === 1 ? '' : 's'} failed after OpenClaw adopted the turn.`,
          remediation: 'Resolve the named diagnostic, then use a new comment revision.',
          status: 'warning' as const,
        }));
      const commentReplyFindings = [...commentReplyFailureCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({
          code,
          message: `${count} GitHub comment response${count === 1 ? '' : 's'} remained private because public reply delivery failed.`,
          remediation:
            'The private response remains available. Resolve the named diagnostic; automatic reply replay is not currently supported.',
          status: 'warning' as const,
        }));
      const commentPendingFindings = [
        ...(commentBaselinePendingCount === 0
          ? []
          : [
              {
                code: 'github-notification-comment-baseline-pending',
                message: `${commentBaselinePendingCount} active GitHub issue conversation${commentBaselinePendingCount === 1 ? ' is' : 's are'} waiting for a safe comment baseline.`,
                remediation: 'Run openclaw agent-system notifications refresh.',
                status: 'warning' as const,
              },
            ]),
        ...(commentResponsePendingCount === 0
          ? []
          : [
              {
                code: 'github-notification-comment-response-pending',
                message: `${commentResponsePendingCount} admitted GitHub comment${commentResponsePendingCount === 1 ? ' is' : 's are'} waiting for its private response or publication checkpoint.`,
                remediation: 'Keep the OpenClaw Gateway running until comment delivery settles.',
                status: 'warning' as const,
              },
            ]),
      ];
      return [
        ...routingFinding,
        ...activationFindings,
        ...acknowledgmentFindings,
        ...acknowledgmentPendingFindings,
        ...commentDiagnosticFindings,
        ...commentDispatchFindings,
        ...commentReplyFindings,
        ...commentPendingFindings,
        {
          code: 'github-notification-monitor-healthy',
          message: `The GitHub notification monitor last completed a successful read-only observation at ${isoTime(state.lastSuccessfulPollAt)}.`,
          status: 'healthy' as const,
        },
      ];
    },
    async reconcile(context) {
      try {
        const result = await dependencies.routingService.reconcile(desiredState(context));
        const disabled = !context.manifest.github?.notifications;
        const initialState = await dependencies.stateStore?.read(context.manifest.agent.id);
        let state = initialState;
        if (
          disabled &&
          githubNotificationRetirementItemKeys(state).length > 0 &&
          dependencies.monitorService !== undefined
        ) {
          await dependencies.monitorService.runOnce({
            agentId: context.manifest.agent.id,
            bypassInterval: true,
            waitForLeaseMs: notificationLifecycleLeaseWaitMs,
          });
          state = await dependencies.stateStore?.read(context.manifest.agent.id);
        }
        const retirementPending =
          disabled && githubNotificationRetirementItemKeys(state).length > 0;
        let monitorStateRemoved = disabled && initialState !== undefined && state === undefined;
        if (
          disabled &&
          !retirementPending &&
          !monitorStateRemoved &&
          dependencies.stateStore?.remove !== undefined
        ) {
          monitorStateRemoved = await dependencies.stateStore.remove(context.manifest.agent.id);
        }
        const warnings = retirementPending
          ? [
              {
                code: 'github-notification-retirement-pending',
                message:
                  'GitHub notification state was retained until the Gateway retires its sessions.',
              },
            ]
          : [];
        let baselineOutcome;
        if (
          !disabled &&
          state?.baselineAt === undefined &&
          dependencies.monitorService !== undefined
        ) {
          const [baseline] = await dependencies.monitorService.runOnce({
            agentId: context.manifest.agent.id,
            bypassInterval: true,
            waitForLeaseMs: notificationLifecycleLeaseWaitMs,
          });
          if (!baseline || baseline.status !== 'completed' || baseline.baselineAt === undefined) {
            const code = baseline?.diagnosticCode ?? baseline?.code ?? 'no-result';
            const retry =
              baseline?.retryAt === undefined ? '' : ` Retry after ${isoTime(baseline.retryAt)}.`;
            throw new AgentSystemLifecycleError(
              'github-notifications',
              'github-notification-baseline-failed',
              `The initial GitHub notification baseline did not complete (code=${code}).${retry}`,
            );
          }
          if (baseline.baselineEstablished) {
            baselineOutcome = {
              code: 'github-notification-baseline-established',
              message: `GitHub notification baseline established with ${baseline.baseline ?? 0} existing assignments.`,
              status: 'created' as const,
            };
          }
        }
        if (result.plan.kind === 'noop' && result.plan.code === 'notification-routing-disabled') {
          return {
            outcomes: monitorStateRemoved
              ? [
                  {
                    code: 'github-notification-monitor-state-removed',
                    message: 'private GitHub notification monitor state',
                    status: 'removed' as const,
                  },
                ]
              : [],
            warnings,
          };
        }
        const status =
          result.plan.kind === 'remove' || result.plan.kind === 'forget'
            ? ('removed' as const)
            : result.plan.kind === 'upsert'
              ? result.configChanged
                ? ('updated' as const)
                : ('unchanged' as const)
              : result.plan.kind === 'adopt'
                ? ('created' as const)
                : ('unchanged' as const);
        return {
          outcomes: [
            {
              code: result.plan.code,
              message: result.requiresManualRestart
                ? `${result.plan.message} Restart the OpenClaw Gateway to apply this change because gateway.reload.mode is off.`
                : result.plan.message,
              status,
            },
            ...(monitorStateRemoved
              ? [
                  {
                    code: 'github-notification-monitor-state-removed',
                    message: 'private GitHub notification monitor state',
                    status: 'removed' as const,
                  },
                ]
              : []),
            ...(baselineOutcome ? [baselineOutcome] : []),
          ],
          warnings,
        };
      } catch (error) {
        if (error instanceof AgentSystemLifecycleError) throw error;
        throw new AgentSystemLifecycleError(
          'github-notifications',
          'github-notifications-reconcile-failed',
          error instanceof Error
            ? error.message
            : 'GitHub notification routing could not be reconciled.',
          { cause: error },
        );
      }
    },
  };
}
