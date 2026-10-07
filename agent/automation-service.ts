import { realpath } from 'node:fs/promises';

import {
  AutomationError,
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

/** own explicit reconciliation; no timers, model calls, credentials or private scheduler access. */
export default class AutomationService {
  constructor(readonly dependencies: AutomationServiceDependencies) {}

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
      ...(manifest.automations ?? []).map(({ id }) => id),
      ...ledger.records.map(({ id }) => id),
    ]);
    return {
      runtime: 'openclaw',
      workspaceDir: context.workspaceDir,
      status: findings.some(({ status }) => status !== 'healthy' && status !== 'skipped')
        ? 'attention'
        : 'aligned',
      jobs: [...ids].map((id) => {
        const declared = manifest.automations?.find((job) => job.id === id);
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
    if (!record?.nativeId || record.pending)
      throw new AutomationError('automation-owned-job-missing');
    const native = nativeAutomation(
      await this.dependencies.request('cron.get', { id: record.nativeId }),
    );
    if (!this.owned(record, [native], context.agentId))
      throw new AutomationError('automation-owned-job-missing');
    return { context, record, native };
  }

  async run(manifest: AgentManifest, workspaceDir: string, id: string) {
    const job = manifest.automations?.find((entry) => entry.id === id);
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
    if (
      record.hash !== effective.hash ||
      nativeAutomationHash(native) !== record.nativeHash ||
      nativeAutomationHash(native) !== nativeAutomationHash(projectAutomation(job, record, context))
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
      automationHash(loaded.manifest.automations ?? []) !==
        automationHash(manifest.automations ?? [])
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
    return { runtime: 'openclaw', id, nativeId: native.id, status: 'ok', ...result };
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
    const declarations = (manifest.automations ?? []).filter((job) =>
      job.runtimes.includes('openclaw'),
    );
    if (!declarations.length && !ledger.records.length) return [];
    const finding = (
      id: string,
      status: AgentSystemLifecycleFinding['status'],
      code: string,
    ): AgentSystemLifecycleFinding => ({
      component: 'automations',
      stepId: id,
      status,
      code,
      message: `Automation ${id}: ${code.replace(/^automation-/u, '')}${context.threads?.has(id) ? ` (persistent, ${context.threads.get(id)!.outcome}: ${context.threads.get(id)!.id})` : ''}.`,
      ...(status === 'healthy'
        ? {}
        : {
            remediation:
              'Run operator install after resolving the reported condition; no job was executed.',
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
        finding(
          'threads',
          'blocked',
          error instanceof AutomationError ? error.code : 'automation-thread-inspection-failed',
        ),
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
        if (!native || record.pending) {
          findings.push(finding(job.id, 'blocked', 'automation-recovery-required'));
          continue;
        }
        if (native.state.autoDisabled) {
          findings.push(finding(job.id, 'blocked', 'automation-native-safety-disabled'));
          continue;
        }
        const desired = projectAutomation(job, record, context);
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
          findings.push(finding(job.id, 'warning', 'automation-execution-failed'));
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
      const native = this.owned(record, observed, context.agentId);
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
    const declarations = (manifest.automations ?? []).filter((job) =>
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
          if (!native && record.nativeId)
            throw new AutomationError('automation-native-job-missing');
          const declaration = declarations.find(({ id }) => id === record.id);
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
            nativeAutomationHash(native) !== record.pending.nativeHash &&
            nativeAutomationHash(native) !== record.nativeHash
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
        const currentManifestHash = automationHash(manifest.automations ?? []);
        const assertCurrent = async () => {
          const loaded = await this.dependencies.manifestService.loadForAgentId(
            context.agentId,
            'service',
          );
          if (
            loaded.status !== 'loaded' ||
            loaded.manifest.agent.id !== context.agentId ||
            (await realpath(loaded.scope.workspaceDir)) !== context.workspaceDir ||
            automationHash(loaded.manifest.automations ?? []) !== currentManifestHash
          )
            throw new AutomationError('automation-manifest-changed');
        };
        await assertCurrent();
        context.threads = await this.threads(context, store).resolve(declarations, true);
        await assertCurrent();
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
            if (native && nativeAutomationHash(native) === record.pending.nativeHash) {
              record.nativeId = native.id;
              record.nativeHash = record.pending.nativeHash;
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
          const desired = projectAutomation(job, record, context);
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

  private async update(
    request: AutomationGateway,
    store: AutomationStore,
    ledger: AutomationLedger,
    record: AutomationRecord,
    before: NativeAutomation,
    patch: Record<string, unknown>,
    expectedHash: string,
  ): Promise<NativeAutomation> {
    record.pending = { kind: 'update', nativeHash: expectedHash };
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

  async admit(manifest: AgentManifest, workspaceDir: string, id: string, hash: string) {
    const { context, store } = await this.scope(manifest, workspaceDir);
    const ledger = await store.read();
    const record = ledger.records.find((entry) => entry.id === id);
    const job = manifest.automations?.find((entry) => entry.id === id);
    if (
      !record ||
      !job ||
      record.pending ||
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
    if (
      native.declarationKey !== record.marker ||
      native.agentId !== context.agentId ||
      !native.enabled ||
      native.state.autoDisabled ||
      nativeAutomationHash(native) !== record.nativeHash
    )
      throw new AutomationError('automation-execution-drift');
    return { command: { ...job.payload.run, timeoutSeconds: job.timeoutSeconds ?? 1800 }, context };
  }
}
