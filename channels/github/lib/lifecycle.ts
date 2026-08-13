import type { AgentManifest, ManifestDiagnostic } from '../../../utils/manifest-types.ts';
import type { NotificationRoutingDesiredState } from '../utils/routing.ts';
import { githubNotificationRetirementItemKeys } from '../utils/monitor-state.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleContext,
} from '../../../lib/lifecycle-registry.ts';
import type NotificationRoutingService from './routing-service.ts';
import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';

export interface NotificationLifecycleDependencies {
  routingService: Pick<NotificationRoutingService, 'inspect' | 'reconcile'>;
  stateStore?: Pick<GitHubNotificationMonitorStateStore, 'read'> &
    Partial<Pick<GitHubNotificationMonitorStateStore, 'remove'>>;
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
            message: 'The GitHub notification monitor is waiting after a value-free diagnostic.',
            remediation: 'Review Gateway logs and the GitHub notification manifest declaration.',
            status: 'warning' as const,
          },
        ];
      }
      return [
        ...routingFinding,
        {
          code: 'github-notification-monitor-healthy',
          message: 'The GitHub notification monitor has a successful read-only observation.',
          status: 'healthy' as const,
        },
      ];
    },
    async reconcile(context) {
      try {
        const result = await dependencies.routingService.reconcile(desiredState(context));
        const disabled = !context.manifest.github?.notifications;
        const state = disabled
          ? await dependencies.stateStore?.read(context.manifest.agent.id)
          : undefined;
        const retirementPending = githubNotificationRetirementItemKeys(state).length > 0;
        const monitorStateRemoved =
          disabled &&
          !retirementPending &&
          dependencies.stateStore?.remove !== undefined &&
          (await dependencies.stateStore.remove(context.manifest.agent.id));
        const warnings = retirementPending
          ? [
              {
                code: 'github-notification-retirement-pending',
                message:
                  'GitHub notification state was retained until the Gateway retires its sessions.',
              },
            ]
          : [];
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
          ],
          warnings,
        };
      } catch (error) {
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
