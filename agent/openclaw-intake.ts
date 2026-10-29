import { openClawItemOccupied } from './openclaw-capacity.ts';
import OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import projectPickup, { pickupAuthority, type PickupInput } from './project-pickup.ts';
import type { ProjectPickupClient } from '../channels/github/provider/project-pickup-client.ts';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import type { ProjectPickupAuthority } from './project-pickup-authority.ts';
import DiscoveryBudget from './discovery-budget.ts';
import { realpath } from 'node:fs/promises';

import { cliDiagnosticContext } from '../core/cli-diagnostic-context.ts';
import assignmentIntakePolicy from './assignment-intake-policy.ts';
import {
  githubNotificationRuntimeBlocker,
  githubNotificationRuntimeDiagnostics,
} from '../channels/github/notification-policy.ts';
import IntakeRecordStore, {
  IntakeError,
  intakeLocation,
} from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import type { AgentSystemLifecycleContribution } from '../core/lifecycle-registry.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { GitHubNotificationItemSelector } from '../channels/github/provider/work-item.ts';

export interface OpenClawIntakeDependencies {
  projectPickup?: ProjectPickupAuthority;
  root: string;
  resetRoot?: string;
  namespace: string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  connect(
    input: { manifest: AgentManifest; workspaceDir: string },
    signal: AbortSignal,
  ): Promise<GitHubNotificationIntakeClient>;
  now?: () => number;
  readiness?(manifest: AgentManifest, workspace: string): Promise<string | undefined>;
  readinessFailure?(error: unknown): void;
}

/** Workflow admission only. No sessions, assessment results, V1 files or publication. */
export default class OpenClawIntake {
  constructor(readonly dependencies: OpenClawIntakeDependencies) {}
  async select(
    manifest: AgentManifest,
    workspaceDir: string,
    options: { resolvePolicy?: boolean } = {},
  ) {
    const workspace = await realpath(workspaceDir);
    const selected =
      options.resolvePolicy === false ? undefined : assignmentIntakePolicy(manifest, 'openclaw');
    const store = new IntakeRecordStore(
      intakeLocation({
        runtime: 'openclaw',
        root: this.dependencies.root,
        namespace: this.dependencies.namespace,
        workspaceDir: workspace,
        agentId: manifest.agent.id,
        resetRoot: this.dependencies.resetRoot,
      }),
    );
    await new GitHubIdentityCache(store.location).hydrate(manifest.github?.notifications);
    return { selected, store, workspace };
  }
  async readiness(manifest: AgentManifest, workspace: string) {
    try {
      return await this.dependencies.readiness?.(manifest, workspace);
    } catch (error) {
      this.dependencies.readinessFailure?.(error);
      return 'automation-observation-unavailable';
    }
  }
  /** consumes trusted enrollment without creating a schedule or a competing execution loop. */
  async pickup(
    manifest: AgentManifest,
    workspaceDir: string,
    input: PickupInput,
    timezone: string,
  ) {
    if (!this.dependencies.projectPickup)
      throw new IntakeError('project-pickup-activation-required');
    const { store, workspace } = await this.select(manifest, workspaceDir);
    const code = await this.readiness(manifest, workspace);
    if (code) throw new IntakeError(code);
    const journal = new OpenClawDispatchStore(store.location.root, store.location.scope);
    return journal.exclusive(async (state, save, signal) => {
      const readPolicy = async () => {
        const loaded = await this.dependencies.manifestService.loadForAgentId(
          manifest.agent.id,
          'service',
        );
        if (
          loaded.status !== 'loaded' ||
          (await realpath(loaded.scope.workspaceDir)) !== workspace ||
          loaded.manifest.agent.id !== manifest.agent.id
        )
          throw new IntakeError('intake-workspace-binding-changed');
        const live = assignmentIntakePolicy(loaded.manifest, 'openclaw');
        if (!live) throw new IntakeError('intake-policy-disabled');
        return live.policy;
      };
      await readPolicy();
      const client = (await this.dependencies.connect(
        { manifest, workspaceDir: workspace },
        signal,
      )) as ProjectPickupClient;
      if (
        !client.discoverProject ||
        !client.projectCandidate ||
        !client.projectBlocked ||
        !client.assignProjectIssue
      )
        throw new IntakeError('project-pickup-provider-unavailable');
      return projectPickup({
        runtime: 'openclaw',
        scope: store.location.scope,
        workspaceDir: workspace,
        agentId: manifest.agent.id,
        enrollment: this.dependencies.projectPickup!.enrollment,
        timezone,
        state,
        save,
        now: this.dependencies.now ?? Date.now,
        readPolicy,
        client,
        occupied: openClawItemOccupied,
        input,
      });
    });
  }
  async inspect(manifest: AgentManifest, workspaceDir: string) {
    const blocker = githubNotificationRuntimeBlocker(manifest.github?.notifications, 'openclaw');
    if (blocker)
      return {
        status: 'blocked',
        code: blocker.code,
        baselineAt: null,
        checkpoint: null,
        records: [],
      };
    const { selected, store } = await this.select(manifest, workspaceDir);
    const state = await store.read();
    const code = !selected
      ? 'intake-policy-disabled'
      : !state
        ? 'intake-activation-required'
        : state.blocker?.code;
    return {
      status: code ? 'blocked' : 'ready',
      ...(code ? { code } : {}),
      baselineAt: state?.baselineAt ?? null,
      checkpoint: state?.checkpoint ?? null,
      records: state?.records ?? [],
    };
  }
  async run(
    manifest: AgentManifest,
    workspaceDir: string,
    action: 'check' | 'scan' | 'activate',
    _expectedDigest?: string,
    signal?: AbortSignal,
    selector?: GitHubNotificationItemSelector,
    budget = new DiscoveryBudget(20000, signal),
  ) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(action === 'check' ? 25000 : 120000);
    const { selected, store, workspace } = await this.select(manifest, workspaceDir);
    if (!selected) throw new IntakeError('intake-policy-disabled');
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      deadline.throwIfAborted();
      const fresh = await this.dependencies.manifestService.loadForAgentId(
        manifest.agent.id,
        'service',
      );
      if (fresh.status !== 'loaded') throw new IntakeError('intake-manifest-unavailable');
      if (
        fresh.manifest.agent.id !== manifest.agent.id ||
        (await realpath(fresh.scope.workspaceDir)) !== workspace
      )
        throw new IntakeError('intake-workspace-binding-changed');
    };
    await assertCurrent();
    if (action !== 'activate') {
      const code = await this.readiness(manifest, workspace);
      if (code) return { status: 'blocked' as const, code, changed: true };
    }
    const target = store;
    return scanAssignments({
      runtime: 'openclaw',
      readProjectPickup: async () =>
        pickupAuthority(
          (await new OpenClawDispatchStore(store.location.root, store.location.scope).read())
            .projectPickup,
        ) ?? this.dependencies.projectPickup,
      store: target,
      budget,
      workspaceDir: workspace,
      agentId: manifest.agent.id,
      policy: selected.policy,
      policyDigest: selected.digest,
      now: (this.dependencies.now ?? Date.now)(),
      activate: action === 'activate',
      selector,
      assertCurrent,
      readPolicy: async () => {
        await assertCurrent();
        const live = await this.dependencies.manifestService.loadForAgentId(
          manifest.agent.id,
          'service',
        );
        const policy =
          live.status === 'loaded' ? assignmentIntakePolicy(live.manifest, 'openclaw') : undefined;
        if (!policy) throw new IntakeError('intake-policy-disabled');
        return policy;
      },
      connect: async (lockSignal) => {
        await assertCurrent();
        const client = await this.dependencies.connect(
          { manifest, workspaceDir: workspace },
          AbortSignal.any([lockSignal, deadline, budget.signal, ...(signal ? [signal] : [])]),
        );
        await new GitHubIdentityCache(store.location).resolve(
          selected.policy,
          client,
          'assignment',
        );
        const pin = selected.policy.issueAssignment?.allowed.find(
          (a) => a.login.toLowerCase() === selected.username.toLowerCase(),
        );
        if (
          client.identity.login.toLowerCase() !== selected.username.toLowerCase() ||
          (pin && pin.nodeId !== client.identity.nodeId)
        )
          throw new IntakeError('intake-github-identity-mismatch');
        return client;
      },
    });
  }
  contribution(): AgentSystemLifecycleContribution {
    return {
      id: 'github-intake',
      isConfigured: (manifest) => Boolean(manifest.github?.notifications),
      validate: ({ manifest }) => {
        const diagnostics = githubNotificationRuntimeDiagnostics(
          manifest.github?.notifications,
          'openclaw',
        );
        return {
          code: 'github-notifications-declaration-valid',
          summary: 'GitHub notification declaration',
          diagnostics: diagnostics.map(({ code, message, fieldPath, workflow, remediation }) => ({
            [cliDiagnosticContext]: {
              condition: {
                key: `notification-capability:${workflow}`,
                component: 'github-intake',
                fieldPath,
              },
              remediation: [remediation],
            },
            code,
            message,
            fieldPath,
            severity: 'warning' as const,
          })),
        };
      },
      inspect: async ({ manifest, workspaceDir }) => {
        const result = await this.inspect(manifest, workspaceDir);
        const diagnostics = githubNotificationRuntimeDiagnostics(
          manifest.github?.notifications,
          'openclaw',
        );
        if (result.code === 'github-notification-runtime-unsupported') return diagnostics;
        return [
          ...diagnostics,
          {
            component: 'github-intake',
            status:
              result.code === 'intake-policy-disabled'
                ? 'skipped'
                : result.code
                  ? 'drift'
                  : 'healthy',
            code: result.code ?? 'intake-ready',
            message: result.code ?? 'Intake baseline and policy are aligned.',
          },
        ];
      },
      reconcile: async ({ manifest, workspaceDir }) => {
        const diagnostics = githubNotificationRuntimeDiagnostics(
          manifest.github?.notifications,
          'openclaw',
        );
        const warnings = diagnostics.map(({ code, message, fieldPath, workflow, remediation }) => ({
          code,
          message,
          [cliDiagnosticContext]: {
            condition: {
              key: `notification-capability:${workflow}`,
              component: 'github-intake',
              fieldPath,
            },
            remediation: [remediation],
          },
        }));
        const blocker = diagnostics.find(
          ({ status, workflow }) => status === 'blocked' && workflow === 'issue-assignment',
        );
        if (blocker)
          return {
            outcomes: [{ ...blocker, status: 'skipped' as const }],
            warnings,
          };
        if (!assignmentIntakePolicy(manifest, 'openclaw')) return { outcomes: [], warnings };
        const state = await this.inspect(manifest, workspaceDir);
        if (
          state.code &&
          ['intake-activation-required', 'intake-policy-reconciliation-required'].includes(
            state.code,
          )
        ) {
          const result = await this.run(manifest, workspaceDir, 'activate');
          if (result.status !== 'ready')
            throw new IntakeError(result.code ?? 'intake-activation-required');
          return {
            warnings,
            outcomes: [
              {
                component: 'github-intake',
                status: 'updated',
                code: 'intake-activated',
                message: 'Intake baseline and policy retained; no issue sessions created.',
              },
            ],
          };
        }
        return {
          warnings,
          outcomes: [
            {
              component: 'github-intake',
              status: 'unchanged',
              code: 'intake-retained',
              message: 'Intake evidence retained.',
            },
          ],
        };
      },
    };
  }
}
