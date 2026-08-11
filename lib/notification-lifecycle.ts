import type { AgentManifest, ManifestDiagnostic } from '../utils/manifest-types.ts';
import type { NotificationRoutingDesiredState } from '../utils/notification-routing.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleContext,
} from './lifecycle-registry.ts';
import type NotificationRoutingService from './notification-routing-service.ts';

export interface NotificationLifecycleDependencies {
  routingService: Pick<NotificationRoutingService, 'inspect' | 'reconcile'>;
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
  field: 'approvedActors' | 'allowedOwners',
  fieldPath: string,
): ManifestDiagnostic[] {
  const notifications = manifest.github?.notifications;
  const identities =
    field === 'approvedActors'
      ? notifications?.approvedActors
      : notifications?.repositoryPolicy.allowedOwners;
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
  diagnostics.push(
    ...duplicateIdentityDiagnostics(
      manifest,
      'approvedActors',
      '/github/notifications/approved-actors',
    ),
    ...duplicateIdentityDiagnostics(
      manifest,
      'allowedOwners',
      '/github/notifications/repository-policy/allowed-owners',
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
      if (plan.kind === 'noop' && plan.code === 'notification-routing-disabled') return [];
      return [
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
    },
    async reconcile(context) {
      try {
        const result = await dependencies.routingService.reconcile(desiredState(context));
        if (result.plan.kind === 'noop' && result.plan.code === 'notification-routing-disabled') {
          return { outcomes: [] };
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
              message: result.plan.message,
              status,
            },
          ],
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
