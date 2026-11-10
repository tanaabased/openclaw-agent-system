import IssuePickupFailure from './issue-pickup-failure.ts';
import { omit } from 'lodash-es';
import reconcileIssuePickup from './issue-pickup-reconcile.ts';
import issuePickupReport from './issue-pickup-report.ts';
import openClawCapacity, { openClawItemOccupied } from './openclaw-capacity.ts';
import type IssuePickupEnrollmentStore from './issue-pickup-enrollment.ts';
import {
  issuePickupAutomationId,
  issuePickupConfigurationCode,
  issuePickupErrorCode,
} from './issue-pickup-jobs.ts';
import OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import AssignmentClaimStore from './assignment-claim-store.ts';
import issuePickup, { pickupAuthority, type PickupInput } from './issue-pickup.ts';
import type { IssuePickupClient } from '../channels/github/provider/issue-pickup-client.ts';
import { assertDispatchStorage, dispatchStorageNotice } from './dispatch-storage.ts';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import type { IssuePickupAuthority } from './issue-pickup-authority.ts';
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
  issuePickup?: IssuePickupAuthority;
  pickupStore?: IssuePickupEnrollmentStore;
  root: string;
  resetRoot?: string;
  namespace: string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  connect(
    input: { manifest: AgentManifest; workspaceDir: string },
    signal: AbortSignal,
  ): Promise<GitHubNotificationIntakeClient>;
  now?: () => number;
  readiness?(
    manifest: AgentManifest,
    workspace: string,
    automationId?: string,
    expectedNativeId?: string,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
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
  async readiness(
    manifest: AgentManifest,
    workspace: string,
    automationId?: string,
    expectedNativeId?: string,
    signal?: AbortSignal,
  ) {
    try {
      return await this.dependencies.readiness?.(
        manifest,
        workspace,
        automationId,
        expectedNativeId,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
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
    occurrence?: { nativeId: string; runId?: string; assertCurrent(): Promise<void> },
  ) {
    try {
      const { store, workspace } = await this.select(manifest, workspaceDir);
      let authority = this.dependencies.issuePickup;
      if (!authority) {
        if (!this.dependencies.pickupStore || !manifest.github?.notifications || !occurrence)
          throw new IntakeError('issue-pickup-native-caller-required');
        await occurrence.assertCurrent();
        const retained = await this.dependencies.pickupStore.inspect(
          manifest.github.notifications,
          'openclaw',
          store.location.scope,
        );
        if (retained.nativeId !== occurrence.nativeId)
          throw new IntakeError('issue-pickup-native-caller-required');
        authority = { enrollment: retained.enrollment, receipts: [] };
      }
      const code = await this.readiness(manifest, workspace);
      if (code) throw new IntakeError(code);
      const journal = new OpenClawDispatchStore(store.location.root, store.location.scope);
      return await journal.exclusive(async (state, save, signal) => {
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
          if (!this.dependencies.issuePickup) {
            await occurrence!.assertCurrent();
            await this.dependencies.pickupStore!.inspect(
              live.policy,
              'openclaw',
              store.location.scope,
            );
          }
          return live.policy;
        };
        await readPolicy();
        const client = (await this.dependencies.connect(
          { manifest, workspaceDir: workspace },
          signal,
        )) as IssuePickupClient;
        if (
          !client.discoverProject ||
          !client.projectCandidate ||
          !client.projectBlocked ||
          !client.assignProjectIssue
        )
          throw new IntakeError('issue-pickup-provider-unavailable');
        const result = await issuePickup({
          runtime: 'openclaw',
          scope: store.location.scope,
          workspaceDir: workspace,
          agentId: manifest.agent.id,
          enrollment: authority.enrollment,
          timezone,
          state,
          save,
          assertWriteCapacity: () => {
            assertDispatchStorage(state, true);
          },
          now: this.dependencies.now ?? Date.now,
          readPolicy,
          client,
          instance: {
            inspect: async () =>
              this.dependencies.pickupStore
                ? new AssignmentClaimStore(this.dependencies.pickupStore.root).inspect()
                : undefined,
          },
          runId: occurrence?.runId ?? authority.enrollment.id,
          occupied: openClawItemOccupied,
          input,
        });
        if (['material', 'selection-required', 'discovering'].includes(result.status))
          return {
            ...result,
            response: '',
            instructions:
              'instructions' in result
                ? result.instructions
                : result.status === 'discovering'
                  ? 'Call pickup again to continue discovery.'
                  : 'Follow next until the complete material is restored before selection.',
          };
        const reportPolicy = await readPolicy();
        const report = issuePickupReport({
          outcome: result,
          debug: manifest.debug,
          capacity: {
            occupied: openClawCapacity(
              state.records,
              reportPolicy.maxConcurrentItems,
              state.projectPickup,
            ).occupied,
            limit: reportPolicy.maxConcurrentItems,
          },
        });
        return {
          ...omit(result, ['selectionGuidance']),
          response: report.response,
          instructions:
            'instructions' in result
              ? result.instructions
              : 'Reproduce response unchanged as the whole final report. An empty response means no card. Report preparation does not prove visible delivery.',
        };
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new IssuePickupFailure(error, { debug: manifest.debug });
    }
  }
  async preparePickup(manifest: AgentManifest, workspaceDir: string) {
    const { selected, store, workspace } = await this.select(manifest, workspaceDir);
    if (!selected || !this.dependencies.pickupStore)
      throw new IntakeError('issue-pickup-activation-required');
    const pickupStore = this.dependencies.pickupStore;
    const code = issuePickupConfigurationCode(selected.policy);
    if (code) throw new IntakeError(code);
    await this.dependencies.pickupStore.owner();
    const client = (await this.dependencies.connect(
      { manifest, workspaceDir: workspace },
      AbortSignal.timeout(30_000),
    )) as IssuePickupClient;
    if (client.identity.login.toLowerCase() !== selected.username.toLowerCase())
      throw new IntakeError('intake-github-identity-mismatch');
    await new GitHubIdentityCache(store.location).resolve(selected.policy, client, 'assignment');
    return new OpenClawDispatchStore(store.location.root, store.location.scope).exclusive(
      async (state, save) =>
        pickupStore.prepare({
          policy: selected.policy,
          runtime: 'openclaw',
          scope: store.location.scope,
          workspaceDir: workspace,
          agentId: manifest.agent.id,
          client,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          now: (this.dependencies.now ?? Date.now)(),
          reconcile: (record, commit) => reconcileIssuePickup(state, save, record, commit),
        }),
    );
  }
  async inspectPickup(manifest: AgentManifest, workspaceDir: string) {
    const policy = manifest.github?.notifications;
    if (!policy?.issuePickup) return [];
    let code: string | undefined = issuePickupConfigurationCode(policy);
    try {
      if (!code) {
        const { store, workspace } = await this.select(manifest, workspaceDir);
        if (!this.dependencies.pickupStore) throw new Error('issue-pickup-activation-required');
        const enrollment = await this.dependencies.pickupStore.inspect(
          policy,
          'openclaw',
          store.location.scope,
        );
        if (!enrollment.nativeId) throw new Error('issue-pickup-activation-required');
        code = this.dependencies.readiness
          ? await this.readiness(manifest, workspace, issuePickupAutomationId, enrollment.nativeId)
          : 'issue-pickup-observation-unavailable';
      }
    } catch (error) {
      code = issuePickupErrorCode(error);
    }
    return [
      {
        component: 'github-intake',
        status: code ? ('drift' as const) : ('healthy' as const),
        code: code ?? 'issue-pickup-ready',
        message: code ?? 'Issue pickup enrollment and native schedule are ready.',
        ...(code
          ? {
              remediation:
                'Check the designated installation, cadence and window, then run Install to reconcile its native pickup job. Preserve pending pickup work.',
            }
          : {}),
      },
    ];
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
      ...(this.dependencies.resetRoot
        ? {
            storage: dispatchStorageNotice(
              await new OpenClawDispatchStore(
                this.dependencies.resetRoot,
                store.location.scope,
              ).read(),
            ),
          }
        : {}),
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
    const started = budget.clock();
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(action === 'check' ? 25000 : 120000);
    const { selected, store, workspace } = await budget.read('intake-scope', () =>
      this.select(manifest, workspaceDir),
    );
    if (!selected) throw new IntakeError('intake-policy-disabled');
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      deadline.throwIfAborted();
      const fresh = await budget.read('intake-manifest', () =>
        this.dependencies.manifestService.loadForAgentId(manifest.agent.id, 'service'),
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
      const code = await budget.read('automation-readiness', () =>
        this.readiness(manifest, workspace, undefined, undefined, budget.signal),
      );
      if (code)
        return {
          status: 'blocked' as const,
          code,
          changed: true,
          diagnostic: {
            phase: 'automation-readiness',
            elapsedMs: Math.max(0, budget.clock() - started),
            reason: code,
          },
        };
    }
    const target = store;
    return scanAssignments({
      runtime: 'openclaw',
      readIssuePickup: async () =>
        pickupAuthority(
          (await new OpenClawDispatchStore(store.location.root, store.location.scope).read())
            .projectPickup,
        ) ?? this.dependencies.issuePickup,
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
        const client = await budget.read('assignment-connection', () =>
          this.dependencies.connect(
            { manifest, workspaceDir: workspace },
            AbortSignal.any([lockSignal, deadline, budget.signal, ...(signal ? [signal] : [])]),
          ),
        );
        await budget.read('assignment-identities', () =>
          new GitHubIdentityCache(store.location).resolve(selected.policy, client, 'assignment'),
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
          ...(await this.inspectPickup(manifest, workspaceDir)),
          ...(result.storage && result.storage.level !== 'normal'
            ? [
                {
                  component: 'github-intake',
                  status: 'warning' as const,
                  code: 'dispatch-storage-' + result.storage.level,
                  message: result.storage.message,
                  remediation:
                    'Reconcile verified retired history; keep existing work in its owning chat.',
                },
              ]
            : []),
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
