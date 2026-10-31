import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import AutomationReportStore, { type AutomationReportRecord } from './automation-report-store.ts';

import {
  automationReportDelivery,
  type AutomationReportTarget,
} from './automation-report-delivery.ts';
import openclawIntakeJobs from './openclaw-intake-policy.ts';

import {
  AutomationError,
  isOperatorAutomationGateway,
  listNativeAutomations,
  nativeAutomation,
  nativeAutomationHistory,
  nativeAutomationRun,
  type AutomationHistoryOptions,
  type AutomationGateway,
  type NativeAutomation,
} from './automation-gateway.ts';
import {
  automationPatch,
  effectiveAutomation,
  nativeAutomationHash,
  projectAutomation,
  retainedOneShot,
  type AutomationProjectionContext,
} from './automation-projection.ts';
import automationThreadGateway from './automation-thread-gateway.ts';
import AutomationThreads, {
  automationSettingsMessage,
  AutomationThreadSettingsError,
  automationThreadNames,
  automationThreadSelection,
} from './automation-threads.ts';
import AutomationStore, {
  automationHash,
  type AutomationLedger,
  type AutomationRecord,
} from './automation-store.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleFinding,
  type AgentSystemLifecycleOutcome,
  type AgentSystemLifecycleReconcileResult,
} from '../core/lifecycle-registry.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { AgentManifest } from '../manifest/types.ts';

export interface AutomationServiceDependencies {
  root: string;
  profile: string;
  command: string[];
  environment: Record<string, string>;
  timezone?: string;
  now?: () => number;
  request?: AutomationGateway;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
}

const executionFailureReasons = new Set([
  'auth',
  'auth_permanent',
  'format',
  'rate_limit',
  'overloaded',
  'billing',
  'server_error',
  'timeout',
  'tls_certificate',
  'context_overflow',
  'model_not_found',
  'session_expired',
  'empty_response',
  'no_error_details',
  'unclassified',
  'unknown',
]);

const retirementConfirmationWindowMs = 24 * 60 * 60 * 1000;

/** a completed one-shot may disable itself while a capture-only update awaits acknowledgement. */
function pendingNativeHash(record: AutomationRecord, native: NativeAutomation): string {
  if (
    record.pending?.kind === 'update' &&
    record.pending.outputLimitOnly &&
    !native.enabled &&
    retainedOneShot(native)
  ) {
    const beforeCompletion = nativeAutomationHash({ ...native, enabled: true });
    if (beforeCompletion === record.pending.nativeHash || beforeCompletion === record.nativeHash)
      return beforeCompletion;
  }
  return nativeAutomationHash(native);
}

/** native failure reasons are bounded protocol values; never copy raw lastError or diagnostics. */
function executionEvidence(state: NativeAutomation['state']): string {
  const at = state.lastRunAtMs;
  const timestamp =
    typeof at === 'number' && Number.isSafeInteger(at) && Math.abs(at) <= 8.64e15
      ? new Date(at).toISOString()
      : 'unavailable';
  const reason =
    typeof state.lastErrorReason === 'string' && executionFailureReasons.has(state.lastErrorReason)
      ? state.lastErrorReason
      : 'unavailable';
  return ` (last run: ${timestamp}; failure reason: ${reason})`;
}

/** own explicit reconciliation; no timers, model calls, credentials or private scheduler access. */
export default class AutomationService {
  readonly reports: AutomationReportStore;
  constructor(readonly dependencies: AutomationServiceDependencies) {
    this.reports = new AutomationReportStore(join(dependencies.root, 'reports'), dependencies.now);
  }

  async scope(manifest: AgentManifest, workspaceDir: string) {
    const workspace = await realpath(workspaceDir);
    const context: AutomationProjectionContext = {
      agentId: manifest.agent.id,
      workspaceDir: workspace,
      command: this.dependencies.command,
      environment: this.dependencies.environment,
      timezone: this.dependencies.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const store = new AutomationStore({
      root: this.dependencies.root,
      profile: await realpath(this.dependencies.profile),
      agentId: manifest.agent.id,
      workspaceDir: workspace,
    });
    return { context, store };
  }

  private threads(context: AutomationProjectionContext, store: AutomationStore) {
    return new AutomationThreads(
      { root: this.dependencies.root, scope: store.scope, runtime: 'openclaw' },
      automationThreadGateway(this.dependencies.request!, { ...context, scope: store.scope }),
    );
  }

  contribution(): AgentSystemLifecycleContribution {
    return {
      id: 'automations',
      isConfigured: () => true,
      inspect: ({ manifest, workspaceDir }) => this.inspect(manifest, workspaceDir),
      reconcile: ({ manifest, workspaceDir }) =>
        this.reconcile(manifest, workspaceDir, { deferUnavailableGateway: true }),
    };
  }

  async list(manifest: AgentManifest, workspaceDir: string) {
    const { context, store } = await this.scope(manifest, workspaceDir);
    const ledger = await store.read();
    const observed = this.dependencies.request
      ? await listNativeAutomations(this.dependencies.request)
      : [];
    const findings = await this.inspect(manifest, workspaceDir, {
      context,
      store,
      ledger,
      observed,
    });
    const ids = new Set([
      ...openclawIntakeJobs(manifest).map(({ id }) => id),
      ...ledger.records.map(({ id }) => id),
    ]);
    return {
      runtime: 'openclaw',
      workspaceDir: context.workspaceDir,
      status: findings.some(({ status }) => status !== 'healthy' && status !== 'skipped')
        ? 'attention'
        : 'aligned',
      jobs: [...ids].map((id) => {
        const declared = openclawIntakeJobs(manifest).find((job) => job.id === id);
        const record = ledger.records.find((entry) => entry.id === id);
        const native = record ? this.owned(record, observed, context.agentId) : undefined;
        return {
          id,
          declared: Boolean(declared),
          enabled: declared?.enabled ?? false,
          applicable: declared?.runtimes.includes('openclaw') ?? true,
          nativeId: record?.nativeId ?? null,
          nativeEnabled: native?.enabled ?? null,
          routing:
            native?.sessionTarget ??
            (declared && automationThreadSelection(declared, 'openclaw')
              ? 'persistent-pending'
              : 'independent'),
          execution: ['ok', 'error', 'skipped'].includes(String(native?.state.lastRunStatus))
            ? native!.state.lastRunStatus
            : 'unavailable',
          delivery: ['delivered', 'not-delivered', 'unknown', 'not-requested'].includes(
            String(native?.state.lastDeliveryStatus),
          )
            ? native!.state.lastDeliveryStatus
            : 'unavailable',
          removed: record?.removed ?? false,
          retired: Boolean(record?.retired),
          findings: findings.filter(({ stepId }) => stepId === id),
        };
      }),
      findings,
    };
  }

  private async resolveOwned(manifest: AgentManifest, workspaceDir: string, id: string) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) throw new AutomationError('automation-id-invalid');
    if (!this.dependencies.request) throw new AutomationError('automation-requires-operator-sync');
    const { context, store } = await this.scope(manifest, workspaceDir);
    const ledger = await store.read();
    const record = ledger.records.find((entry) => entry.id === id);
    if (!record?.nativeId || record.pending || record.retired)
      throw new AutomationError('automation-owned-job-missing');
    const native = nativeAutomation(
      await this.dependencies.request('cron.get', { id: record.nativeId }),
    );
    if (!this.owned(record, [native], context.agentId))
      throw new AutomationError('automation-owned-job-missing');
    return { context, record, native };
  }

  async notificationResetSnapshot(manifest: AgentManifest, workspace: string, id: string) {
    const { native } = await this.resolveOwned(manifest, workspace, id);
    return {
      id,
      nativeId: native.id,
      enabled: native.enabled,
      hash: nativeAutomationHash({ ...native, enabled: false }),
      ...(typeof native.sessionTarget === 'string' && native.sessionTarget.startsWith('session:')
        ? { sessionKey: native.sessionTarget.slice(8) }
        : {}),
    };
  }

  /** temporarily pause an owned job without changing its installed desired-state receipt. */
  async notificationResetToggle(
    manifest: AgentManifest,
    workspace: string,
    expected: Awaited<ReturnType<AutomationService['notificationResetSnapshot']>>,
    restore: boolean,
  ) {
    const { store } = await this.scope(manifest, workspace);
    return store.withLock(async () => {
      const { native } = await this.resolveOwned(manifest, workspace, expected.id);
      if (
        native.id !== expected.nativeId ||
        nativeAutomationHash({ ...native, enabled: false }) !== expected.hash
      )
        throw new Error('notification-reset-automation-changed');
      const enabled = restore ? expected.enabled : false;
      if (native.enabled !== enabled)
        await this.dependencies.request!('cron.update', {
          id: native.id,
          expectedConfigRevision: native.configRevision,
          patch: { enabled },
        });
      const after = await this.notificationResetSnapshot(manifest, workspace, expected.id);
      if (
        after.nativeId !== expected.nativeId ||
        after.hash !== expected.hash ||
        after.enabled !== enabled
      )
        throw new Error('notification-reset-automation-unverified');
    });
  }

  /** replace only the reset coordinator while its native schedule remains paused. */
  async notificationResetReplace(
    manifest: AgentManifest,
    workspace: string,
    expected: Awaited<ReturnType<AutomationService['notificationResetSnapshot']>>,
    attempted: boolean,
    beforeUpdate: () => Promise<void>,
  ) {
    const { context, store } = await this.scope(manifest, workspace);
    return store.withLock(async () => {
      const { native } = await this.resolveOwned(manifest, workspace, expected.id);
      if (
        native.id !== expected.nativeId ||
        native.enabled ||
        !expected.sessionKey ||
        nativeAutomationHash({
          ...native,
          enabled: false,
          sessionTarget: `session:${expected.sessionKey}`,
        }) !== expected.hash
      )
        throw new Error('notification-reset-automation-changed');
      const job = openclawIntakeJobs(manifest).find(({ id }) => id === expected.id);
      if (!job) throw new Error('notification-reset-coordinator-missing');
      context.threads = await this.threads(context, store).resolve([job], true);
      const target = context.threads.get(job.id)?.id;
      if (!target || target === expected.sessionKey)
        throw new Error('notification-reset-coordinator-not-replaced');
      const sessionTarget = `session:${target}`;
      if (native.sessionTarget !== sessionTarget) {
        if (native.sessionTarget !== `session:${expected.sessionKey}` || attempted)
          throw new Error('notification-reset-native-action-unverified');
        await beforeUpdate();
        await this.dependencies.request!('cron.update', {
          id: native.id,
          expectedConfigRevision: native.configRevision,
          patch: { sessionTarget },
        });
      }
      const after = nativeAutomation(
        await this.dependencies.request!('cron.get', { id: native.id }),
      );
      if (
        after.enabled ||
        after.sessionTarget !== sessionTarget ||
        nativeAutomationHash({ ...after, sessionTarget: `session:${expected.sessionKey}` }) !==
          expected.hash
      )
        throw new Error('notification-reset-automation-unverified');
      const ledger = await store.read();
      const record = ledger.records.find(({ id }) => id === job.id)!;
      const effective = effectiveAutomation(job, context);
      record.hash = effective.hash;
      record.triggerHash = effective.triggerHash;
      // retain the restored setting; the temporary pause is not installed drift.
      record.nativeHash = nativeAutomationHash({ ...after, enabled: expected.enabled });
      await store.write(ledger);
      return { ...expected, sessionKey: target, hash: nativeAutomationHash(after) };
    });
  }

  async run(manifest: AgentManifest, workspaceDir: string, id: string) {
    const job = openclawIntakeJobs(manifest).find((entry) => entry.id === id);
    if (!job) throw new AutomationError('automation-id-missing');
    if (!job.runtimes.includes('openclaw'))
      throw new AutomationError('automation-runtime-unsupported');
    const { context, record, native } = await this.resolveOwned(manifest, workspaceDir, id);
    if (automationThreadSelection(job, 'openclaw')) {
      const { store } = await this.scope(manifest, workspaceDir);
      context.threads = await this.threads(context, store).resolve([job]);
    }
    if (
      !job.enabled ||
      record.removed ||
      !native.enabled ||
      native.state.autoDisabled ||
      retainedOneShot(native)
    )
      throw new AutomationError('automation-run-disabled');
    const effective = effectiveAutomation(job, context);
    const desired = projectAutomation(job, record, context, native);
    // an unchanged installed legacy job stays runnable until explicit reconciliation.
    // the retained native hash below still rejects externally modified settings.
    if (desired.payload.outputMaxBytes !== undefined)
      desired.payload.outputMaxBytes = native.payload.outputMaxBytes;
    if (
      record.hash !== effective.hash ||
      nativeAutomationHash(native) !== record.nativeHash ||
      nativeAutomationHash(native) !== nativeAutomationHash(desired)
    )
      throw new AutomationError('automation-execution-drift');
    const loaded = await this.dependencies.manifestService.loadForAgentId(
      context.agentId,
      'service',
    );
    if (
      loaded.status !== 'loaded' ||
      loaded.manifest.agent.id !== context.agentId ||
      (await realpath(loaded.scope.workspaceDir)) !== context.workspaceDir ||
      automationHash(openclawIntakeJobs(loaded.manifest)) !==
        automationHash(openclawIntakeJobs(manifest))
    )
      throw new AutomationError('automation-manifest-changed');
    const result = nativeAutomationRun(
      await this.dependencies.request!('cron.run', { id: native.id, mode: 'if-enabled' }),
    );
    return {
      runtime: 'openclaw',
      id,
      nativeId: native.id,
      ...result,
      execution: 'unavailable',
      delivery: 'unavailable',
    };
  }

  async runs(
    manifest: AgentManifest,
    workspaceDir: string,
    id: string,
    options: AutomationHistoryOptions,
  ) {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 200 ||
      !Number.isSafeInteger(options.offset) ||
      options.offset < 0 ||
      (options.runId !== undefined && !options.runId.trim())
    )
      throw new AutomationError('automation-history-options-invalid');
    const { native } = await this.resolveOwned(manifest, workspaceDir, id);
    const result = nativeAutomationHistory(
      await this.dependencies.request!('cron.runs', {
        id: native.id,
        limit: options.limit,
        offset: options.offset,
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
      }),
      native.id,
      options,
    );
    const { store } = await this.scope(manifest, workspaceDir);
    const reports = [];
    for (const executionId of await this.reports.ids()) {
      const report = await this.reports.read(executionId);
      if (report?.target.scope !== store.scope || report.input.id !== id) continue;
      reports.push({
        ...automationReportDelivery(report),
        startedAt: report.input.startedAt,
        execution: report.input.outcome,
        reason: report.input.reason,
        requested: { model: report.target.model, effort: report.target.effort },
        effective: report.effective,
      });
    }
    reports.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return {
      runtime: 'openclaw',
      id,
      nativeId: native.id,
      status: 'ok',
      ...result,
      reports: reports.slice(options.offset, options.offset + options.limit),
      reportsTotal: reports.length,
    };
  }

  async inspect(
    manifest: AgentManifest,
    workspaceDir: string,
    snapshot?: {
      context: AutomationProjectionContext;
      store: AutomationStore;
      ledger: AutomationLedger;
      observed: NativeAutomation[];
    },
  ): Promise<AgentSystemLifecycleFinding[]> {
    const { store, context } = snapshot ?? (await this.scope(manifest, workspaceDir));
    const ledger = snapshot?.ledger ?? (await store.read());
    const declarations = openclawIntakeJobs(manifest).filter((job) =>
      job.runtimes.includes('openclaw'),
    );
    if (!declarations.length && !ledger.records.length) return [];
    const finding = (
      id: string,
      status: AgentSystemLifecycleFinding['status'],
      code: string,
      execution?: NativeAutomation['state'],
    ): AgentSystemLifecycleFinding => ({
      component: 'automations',
      stepId: id,
      status,
      code,
      ...(context.threads?.get(id)?.settings
        ? { settings: context.threads.get(id)!.settings }
        : {}),
      message: `${context.threads?.get(id)?.settings ? automationSettingsMessage(context.threads.get(id)!.settings!) + '; ' : ''}Automation ${id}: ${code.replace(/^automation-/u, '')}${execution ? executionEvidence(execution) : ''}${context.threads?.has(id) ? ` (persistent, ${context.threads.get(id)!.outcome}: ${context.threads.get(id)!.id})` : ''}.`,
      ...(status === 'healthy'
        ? {}
        : {
            remediation:
              code === 'automation-retired-id'
                ? 'Choose a new manifest ID for a new automation; install will not recreate a retired identity. Preserve its historical receipt for explicit operator recovery.'
                : code === 'automation-execution-failed' ||
                    code === 'automation-delivery-failed' ||
                    code === 'automation-delivery-unavailable'
                  ? `inspect owned run history: openclaw agent-system automations runs ${id} --agent ${context.agentId} --json. no job was executed.`
                  : 'Run operator install after resolving the reported condition; no job was executed.',
          }),
    });
    if (!this.dependencies.request)
      return [finding('operator', 'manual', 'automation-requires-operator-sync')];
    const observed = snapshot?.observed ?? (await listNativeAutomations(this.dependencies.request));
    const findings: AgentSystemLifecycleFinding[] = [];
    const status = await this.dependencies.request('cron.status', {});
    if (status.enabled === false)
      findings.push(finding('scheduler', 'blocked', 'automation-scheduler-disabled'));
    else if (status.enabled !== true)
      findings.push(finding('scheduler', 'blocked', 'automation-scheduler-status-unavailable'));
    try {
      context.threads = await this.threads(context, store).resolve(declarations);
    } catch (error) {
      return [
        ...findings,
        {
          ...finding(
            error instanceof AutomationError ? (error.automationId ?? 'threads') : 'threads',
            'blocked',
            error instanceof AutomationError ? error.code : 'automation-thread-inspection-failed',
          ),
          ...(error instanceof AutomationThreadSettingsError
            ? {
                message: `${error.code}; ${automationSettingsMessage(error.settings)}`,
                settings: error.settings,
              }
            : {}),
        },
      ];
    }
    for (const job of declarations) {
      try {
        effectiveAutomation(job, context);
        const record = ledger.records.find(({ id }) => id === job.id);
        if (!record) {
          const orphan = observed.some((native) => native.declarationKey === store.marker(job.id));
          findings.push(
            finding(
              job.id,
              orphan ? 'blocked' : 'drift',
              orphan ? 'automation-ownership-missing' : 'automation-missing',
            ),
          );
          continue;
        }
        const native = this.owned(record, observed, context.agentId);
        if (record.retired) {
          findings.push(finding(job.id, 'blocked', 'automation-retired-id'));
          continue;
        }
        if (!native || record.pending) {
          findings.push(finding(job.id, 'blocked', 'automation-recovery-required'));
          continue;
        }
        if (native.state.autoDisabled) {
          findings.push(finding(job.id, 'blocked', 'automation-native-safety-disabled'));
          continue;
        }
        const desired = projectAutomation(job, record, context, native);
        if (
          retainedOneShot(native) &&
          record.triggerHash === effectiveAutomation(job, context).triggerHash
        )
          desired.enabled = false;
        const drift =
          record.hash !== effectiveAutomation(job, context).hash ||
          record.removed ||
          nativeAutomationHash(native) !== nativeAutomationHash(desired);
        findings.push(
          finding(
            job.id,
            drift ? 'drift' : 'healthy',
            drift
              ? 'automation-drift'
              : retainedOneShot(native)
                ? 'automation-completed'
                : !job.enabled
                  ? 'automation-disabled'
                  : 'automation-healthy',
          ),
        );
        if (native.state.lastRunAtMs && native.state.lastDeliveryStatus === undefined) {
          findings.push(finding(job.id, 'skipped', 'automation-delivery-unavailable'));
        }
        if (native.state.lastRunStatus === 'error')
          findings.push(finding(job.id, 'warning', 'automation-execution-failed', native.state));
        if (native.state.lastDeliveryStatus === 'not-delivered' || native.state.lastDeliveryError)
          findings.push(finding(job.id, 'warning', 'automation-delivery-failed'));
      } catch (error) {
        findings.push(
          finding(
            job.id,
            'blocked',
            error instanceof AutomationError ? error.code : 'automation-inspection-failed',
          ),
        );
      }
    }
    for (const record of ledger.records.filter(
      (record) => !declarations.some(({ id }) => id === record.id),
    )) {
      try {
        const native = this.owned(record, observed, context.agentId);
        if (!native && !record.pending && record.nativeId) {
          const authoritative =
            isOperatorAutomationGateway(this.dependencies.request) &&
            Number.isSafeInteger(status.jobs) &&
            status.jobs === observed.length;
          const code = authoritative
            ? record.retired
              ? 'automation-retired'
              : 'automation-retirement-pending'
            : 'automation-inspection-incomplete';
          if (
            code !== 'automation-retired' ||
            !record.retired ||
            !this.retirementConfirmationExpired(record.retired.atMs)
          )
            findings.push(
              finding(
                record.id,
                authoritative ? (record.retired ? 'healthy' : 'drift') : 'blocked',
                code,
              ),
            );
          continue;
        }
        findings.push(
          finding(
            record.id,
            !native || record.pending
              ? 'blocked'
              : native.enabled || !record.removed
                ? 'drift'
                : 'healthy',
            !native || record.pending
              ? 'automation-recovery-required'
              : native.enabled || !record.removed
                ? 'automation-removal-pending'
                : 'automation-disabled',
          ),
        );
      } catch (error) {
        findings.push(
          finding(
            record.id,
            'blocked',
            error instanceof AutomationError ? error.code : 'automation-inspection-failed',
          ),
        );
      }
    }
    return findings;
  }

  owned(
    record: AutomationRecord,
    jobs: NativeAutomation[],
    agentId: string,
  ): NativeAutomation | undefined {
    const matches = jobs.filter(
      (job) => job.declarationKey === record.marker || job.id === record.nativeId,
    );
    if (
      (record.retired && matches.length > 0) ||
      matches.length > 1 ||
      matches.some(
        (job) =>
          job.declarationKey !== record.marker ||
          job.agentId !== agentId ||
          (record.nativeId !== undefined && job.id !== record.nativeId),
      )
    )
      throw new AutomationError('automation-ownership-conflict');
    return matches[0];
  }

  /** explicit sync is strict; install may defer unavailable initial scheduler discovery only. */
  async reconcile(
    manifest: AgentManifest,
    workspaceDir: string,
    options: { deferUnavailableGateway?: boolean } = {},
  ): Promise<AgentSystemLifecycleReconcileResult> {
    const { context, store } = await this.scope(manifest, workspaceDir);
    const initial = await store.read();
    const declarations = openclawIntakeJobs(manifest).filter((job) =>
      job.runtimes.includes('openclaw'),
    );
    if (!declarations.length && !initial.records.length) return { outcomes: [], warnings: [] };
    if (!this.dependencies.request)
      return {
        outcomes: [],
        warnings: [
          {
            component: 'automations',
            code: 'automation-requires-operator-sync',
            message: 'Automation reconciliation requires operator openclaw agent-system install.',
          },
        ],
      };
    const request = this.dependencies.request;
    const outcomes: AgentSystemLifecycleOutcome[] = [];
    try {
      return await store.withLock(async () => {
        const ledger = await store.read();
        const initialHash = automationHash(ledger);
        const currentManifestHash = automationHash(openclawIntakeJobs(manifest));
        // validate the complete plan before changing any native job.
        for (const job of declarations) effectiveAutomation(job, context);
        automationThreadNames(declarations, 'openclaw');
        let observed: NativeAutomation[];
        try {
          observed = await listNativeAutomations(request);
        } catch (error) {
          if (
            !options.deferUnavailableGateway ||
            !(error instanceof AutomationError) ||
            error.code !== 'automation-gateway-unavailable'
          )
            throw error;
          const deferred = {
            component: 'automations',
            code: 'automation-sync-deferred',
            message:
              'Automation synchronization is deferred because the Gateway is unavailable; scheduler state was not verified or changed. Retry authorized install or automations sync when the Gateway is available.',
          };
          return {
            outcomes: [{ ...deferred, status: 'skipped' as const }],
            warnings: [deferred],
          };
        }
        for (const record of ledger.records) {
          const native = this.owned(record, observed, context.agentId);
          const declaration = declarations.find(({ id }) => id === record.id);
          if (declaration && record.retired) throw new AutomationError('automation-retired-id');
          if (!native && record.nativeId && (declaration || record.pending))
            throw new AutomationError('automation-native-job-missing');
          if (!native && !declaration) {
            if (record.pending || !record.nativeId)
              throw new AutomationError('automation-recovery-required');
            if (!isOperatorAutomationGateway(request))
              throw new AutomationError('automation-inspection-incomplete');
          }
          if (declaration && native) {
            const effective = effectiveAutomation(declaration, context);
            if (record.pending && record.hash !== effective.hash)
              throw new AutomationError('automation-pending-content-changed');
            if (
              record.triggerHash === effective.triggerHash &&
              native.schedule.kind === 'at' &&
              native.state.lastRunAtMs &&
              !retainedOneShot(native) &&
              native.state.nextRunAtMs === undefined
            ) {
              throw new AutomationError('automation-one-shot-state-ambiguous');
            }
          }
          if (native?.state.autoDisabled)
            throw new AutomationError('automation-native-safety-disabled');
          if (
            record.pending &&
            native &&
            ![record.pending.nativeHash, record.nativeHash].includes(
              pendingNativeHash(record, native),
            )
          ) {
            throw new AutomationError('automation-recovery-diverged');
          }
        }
        for (const native of observed.filter((job) =>
          job.declarationKey?.startsWith(`agent-system:${store.scope}:`),
        )) {
          if (!ledger.records.some((record) => record.marker === native.declarationKey))
            throw new AutomationError('automation-ownership-missing');
        }
        const absent = ledger.records.filter(
          (record) =>
            !declarations.some(({ id }) => id === record.id) &&
            !this.owned(record, observed, context.agentId),
        );
        if (absent.length) {
          const complete = await listNativeAutomations(request, { requireComplete: true });
          for (const record of absent)
            if (this.owned(record, complete, context.agentId))
              throw new AutomationError('automation-native-snapshot-diverged');
        }
        const assertCurrent = async () => {
          const loaded = await this.dependencies.manifestService.loadForAgentId(
            context.agentId,
            'service',
          );
          if (
            loaded.status !== 'loaded' ||
            loaded.manifest.agent.id !== context.agentId ||
            (await realpath(loaded.scope.workspaceDir)) !== context.workspaceDir ||
            automationHash(openclawIntakeJobs(loaded.manifest)) !== currentManifestHash
          )
            throw new AutomationError('automation-manifest-changed');
        };
        await assertCurrent();
        context.threads = await this.threads(context, store).resolve(declarations, true);
        await assertCurrent();
        // absence is re-observed at the retirement boundary, never inferred from not-found.
        for (const record of ledger.records.filter(
          (entry) =>
            !entry.retired &&
            !declarations.some(({ id }) => id === entry.id) &&
            !this.owned(entry, observed, context.agentId),
        )) {
          const fresh = await listNativeAutomations(request, { requireComplete: true });
          if (this.owned(record, fresh, context.agentId))
            throw new AutomationError('automation-native-snapshot-diverged');
          await assertCurrent();
          record.removed = true;
          record.retired = {
            atMs: (this.dependencies.now ?? Date.now)(),
            reason: 'native-job-absent',
          };
          await store.write(ledger);
          outcomes.push({
            component: 'automations',
            stepId: record.id,
            code: 'automation-retired',
            status: 'updated',
            message: `Automation ${record.id} is retired; historical ownership evidence is retained.`,
          });
        }
        for (const job of declarations) {
          const effective = effectiveAutomation(job, context);
          let record = ledger.records.find(({ id }) => id === job.id);
          if (!record) {
            record = {
              id: job.id,
              marker: store.marker(job.id),
              hash: effective.hash,
              triggerHash: effective.triggerHash,
              generation: 1,
              anchorMs: (this.dependencies.now ?? Date.now)(),
              removed: false,
            };
            ledger.records.push(record);
          }
          let native = this.owned(record, observed, context.agentId);
          let created = false;
          if (record.pending) {
            if (!native && record.pending.kind !== 'create')
              throw new AutomationError('automation-recovery-required');
            if (native && pendingNativeHash(record, native) === record.pending.nativeHash) {
              record.nativeId = native.id;
              record.nativeHash = nativeAutomationHash(native);
              delete record.pending;
              await store.write(ledger);
            }
            if (record.hash !== effective.hash)
              throw new AutomationError('automation-pending-content-changed');
          }
          const triggerChanged = record.triggerHash !== effective.triggerHash;
          if (triggerChanged) {
            record.anchorMs = (this.dependencies.now ?? Date.now)();
            record.generation += 1;
            record.triggerHash = effective.triggerHash;
          }
          record.hash = effective.hash;
          const desired = projectAutomation(job, record, context, native);
          if (
            native &&
            automationHash(native.schedule) === automationHash(desired.schedule) &&
            retainedOneShot(native)
          )
            desired.enabled = false;
          if (
            native &&
            automationHash(native.schedule) === automationHash(desired.schedule) &&
            native.schedule.kind === 'at' &&
            native.state.lastRunAtMs &&
            !retainedOneShot(native) &&
            native.state.nextRunAtMs === undefined
          )
            throw new AutomationError('automation-one-shot-state-ambiguous');
          if (!native) {
            await assertCurrent();
            const disabled = { ...desired, enabled: false };
            record.pending = { kind: 'create', nativeHash: nativeAutomationHash(disabled) };
            await store.write(ledger);
            const result = await request('cron.add', disabled);
            const added = nativeAutomation(result.job ?? result);
            const readback = nativeAutomation(await request('cron.get', { id: added.id }));
            created = true;
            if (
              readback.declarationKey !== record.marker ||
              readback.agentId !== context.agentId ||
              nativeAutomationHash(readback) !== record.pending.nativeHash
            )
              throw new AutomationError('automation-readback-diverged');
            record.nativeId = readback.id;
            record.nativeHash = record.pending.nativeHash;
            delete record.pending;
            await store.write(ledger);
            native = readback;
          }
          await assertCurrent();
          const before = nativeAutomation(await request('cron.get', { id: native.id }));
          if (before.configRevision !== native.configRevision)
            throw new AutomationError('automation-native-snapshot-diverged');
          if (before.state.autoDisabled)
            throw new AutomationError('automation-native-safety-disabled');
          if (
            automationHash(before.schedule) === automationHash(desired.schedule) &&
            retainedOneShot(before)
          )
            desired.enabled = false;
          const patch = automationPatch(before, desired);
          const changed = Object.keys(patch).length > 0;
          if (changed)
            native = await this.update(
              request,
              store,
              ledger,
              record,
              before,
              patch,
              nativeAutomationHash(desired),
            );
          record.nativeHash = nativeAutomationHash(native);
          record.removed = false;
          if (retainedOneShot(native))
            record.completion = String(native.state.lastRunStatus ?? native.state.lastStatus);
          delete record.pending;
          if (changed || initialHash !== automationHash(ledger)) await store.write(ledger);
          outcomes.push({
            component: 'automations',
            stepId: job.id,
            code: 'automation-synchronized',
            status: created ? 'created' : changed ? 'updated' : 'unchanged',
            message: `Automation ${job.id} is synchronized (${context.threads?.get(job.id)?.outcome ?? 'independent'}${context.threads?.has(job.id) ? ': ' + context.threads.get(job.id)!.id : ''}).`,
          });
        }
        for (const record of ledger.records.filter(
          (entry) => !declarations.some(({ id }) => id === entry.id),
        )) {
          await assertCurrent();
          if (record.retired) {
            if (
              !this.retirementConfirmationExpired(record.retired.atMs) &&
              !outcomes.some(({ stepId }) => stepId === record.id)
            )
              outcomes.push({
                component: 'automations',
                stepId: record.id,
                code: 'automation-retired',
                status: 'unchanged',
                message: `Automation ${record.id} remains retired.`,
              });
            continue;
          }
          const native = this.owned(record, observed, context.agentId);
          if (!native) throw new AutomationError('automation-recovery-required');
          const before = nativeAutomation(await request('cron.get', { id: native.id }));
          if (before.configRevision !== native.configRevision)
            throw new AutomationError('automation-native-snapshot-diverged');
          if (before.enabled)
            await this.update(
              request,
              store,
              ledger,
              record,
              before,
              { enabled: false },
              nativeAutomationHash({ ...before, enabled: false }),
            );
          if (!record.removed || record.pending) {
            record.removed = true;
            record.nativeId = before.id;
            record.nativeHash = nativeAutomationHash({ ...before, enabled: false });
            delete record.pending;
            await store.write(ledger);
          }
          outcomes.push({
            component: 'automations',
            stepId: record.id,
            code: 'automation-disabled-retained',
            status: before.enabled ? 'updated' : 'unchanged',
            message: `Automation ${record.id} is disabled; ownership and native history are retained.`,
          });
        }
        return { outcomes, warnings: [] };
      });
    } catch (error) {
      const code = error instanceof AutomationError ? error.code : 'automation-reconcile-failed';
      throw new AgentSystemLifecycleError(
        'automations',
        code,
        `Automation reconciliation stopped (${code}).`,
        error instanceof AutomationError ? { cause: error } : undefined,
        undefined,
        undefined,
        { outcomes, warnings: [], unattempted: [{ component: 'automations' }] },
      );
    }
  }

  private retirementConfirmationExpired(atMs: number): boolean {
    return (this.dependencies.now ?? Date.now)() - atMs >= retirementConfirmationWindowMs;
  }

  private async update(
    request: AutomationGateway,
    store: AutomationStore,
    ledger: AutomationLedger,
    record: AutomationRecord,
    before: NativeAutomation,
    patch: Record<string, unknown>,
    expectedHash: string,
  ): Promise<NativeAutomation> {
    const outputMaxBytes = (patch.payload as Record<string, unknown> | undefined)?.outputMaxBytes;
    // preserve admission only when both receipts prove that capture is the sole change.
    const outputLimitOnly =
      before.payload.kind === 'command' &&
      typeof outputMaxBytes === 'number' &&
      outputMaxBytes !== before.payload.outputMaxBytes &&
      nativeAutomationHash(before) === record.nativeHash &&
      nativeAutomationHash({ ...before, payload: { ...before.payload, outputMaxBytes } }) ===
        expectedHash;
    record.pending = {
      kind: 'update',
      nativeHash: expectedHash,
      ...(outputLimitOnly ? { outputLimitOnly: true } : {}),
    };
    await store.write(ledger);
    await request('cron.update', {
      id: before.id,
      expectedConfigRevision: before.configRevision,
      patch,
    });
    const after = nativeAutomation(await request('cron.get', { id: before.id }));
    if (nativeAutomationHash(after) !== expectedHash)
      throw new AutomationError('automation-readback-diverged');
    record.nativeHash = expectedHash;
    delete record.pending;
    await store.write(ledger);
    return after;
  }

  async assertReportCurrent(report: AutomationReportRecord) {
    const loaded = await this.dependencies.manifestService.loadForAgentId(
      report.target.agentId,
      'service',
    );
    if (
      loaded.status !== 'loaded' ||
      loaded.manifest.agent.id !== report.target.agentId ||
      (await realpath(loaded.scope.workspaceDir)) !== report.target.workspaceDir
    )
      throw new AutomationError('automation-report-declaration-changed');
    const { context, store } = await this.scope(loaded.manifest, loaded.scope.workspaceDir);
    const job = openclawIntakeJobs(loaded.manifest).find((entry) => entry.id === report.input.id);
    const record = (await store.read()).records.find((entry) => entry.id === report.input.id);
    if (
      store.scope !== report.target.scope ||
      !job ||
      !job.enabled ||
      !job.runtimes.includes('openclaw') ||
      job.payload.kind !== 'command' ||
      effectiveAutomation(job, context).hash !== report.hash ||
      !record ||
      record.hash !== report.hash ||
      record.retired ||
      record.removed ||
      record.pending
    )
      throw new AutomationError('automation-report-declaration-changed');
  }

  async admit(manifest: AgentManifest, workspaceDir: string, id: string, hash: string) {
    const { context, store } = await this.scope(manifest, workspaceDir);
    const job = openclawIntakeJobs(manifest).find((entry) => entry.id === id);
    // a migration can advance old -> pending -> committed while native state is read.
    // re-read custody before using the observation; retries never mutate or replay an update.
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = (await store.read()).records.find((entry) => entry.id === id);
      const outputLimitOnly =
        record?.pending?.kind === 'update' && record.pending.outputLimitOnly === true;
      if (
        !record ||
        !job ||
        (record.pending && !outputLimitOnly) ||
        record.retired ||
        record.removed ||
        !record.nativeId ||
        !job.enabled ||
        !job.runtimes.includes('openclaw') ||
        job.payload.kind !== 'command' ||
        record.hash !== hash ||
        effectiveAutomation(job, context).hash !== hash ||
        !this.dependencies.request
      ) {
        throw new AutomationError('automation-execution-stale');
      }
      const native = nativeAutomation(
        await this.dependencies.request('cron.get', { id: record.nativeId }),
      );
      const fresh = (await store.read()).records.find((entry) => entry.id === id);
      if (automationHash(fresh ?? null) !== automationHash(record)) continue;
      const nativeHash = nativeAutomationHash(native);
      if (
        native.id !== record.nativeId ||
        native.declarationKey !== record.marker ||
        native.agentId !== context.agentId ||
        !native.enabled ||
        native.state.autoDisabled ||
        (nativeHash !== record.nativeHash &&
          (!outputLimitOnly || nativeHash !== record.pending!.nativeHash))
      )
        throw new AutomationError('automation-execution-drift');
      const selection = automationThreadSelection(job, 'openclaw');
      const reportTarget: AutomationReportTarget | undefined =
        selection &&
        typeof native.sessionTarget === 'string' &&
        native.sessionTarget.startsWith('session:')
          ? {
              sessionKey: native.sessionTarget.slice(8),
              agentId: context.agentId,
              workspaceDir: context.workspaceDir,
              scope: store.scope,
              ...(job.overrides.openclaw?.model ? { model: job.overrides.openclaw.model } : {}),
              ...(job.overrides.openclaw?.effort ? { effort: job.overrides.openclaw.effort } : {}),
            }
          : undefined;
      return {
        command: { ...job.payload.run, timeoutSeconds: job.timeoutSeconds ?? 1800 },
        context,
        reportTarget,
      };
    }
    throw new AutomationError('automation-execution-stale');
  }
}
