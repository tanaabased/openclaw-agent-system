import type AutomationService from './automation-service.ts';
import type { NotificationScheduler } from './automation-readiness.ts';
import { AutomationError } from './automation-gateway.ts';
import { effectiveAutomation, nativeAutomationHash } from './automation-projection.ts';
import openclawIntakeJobs from './openclaw-intake-policy.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

export interface AutomationLifecycleCommandScope {
  loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }>;
  assertActive(): void;
  assertCurrent(): Promise<void>;
}

export interface AutomationLifecycleRun {
  agentId: string;
  workspaceDir: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
  jobId: string;
}

interface RunHookContext extends Partial<AutomationLifecycleRun> {
  trigger?: string;
}

/** Verify the activated declaration without operator credentials or scheduler mutation. */
export async function verifyAutomationLifecycleRun(
  service: Pick<AutomationService, 'scope'>,
  scheduler: NotificationScheduler | undefined,
  manifest: AgentManifest,
  run: AutomationLifecycleRun,
  expectedId?: string,
): Promise<void> {
  const { context, store } = await service.scope(manifest, run.workspaceDir);
  const records = (await store.read()).records.filter(({ nativeId }) => nativeId === run.jobId);
  const record = records[0];
  const declared = openclawIntakeJobs(manifest).find(({ id }) => id === record?.id);
  if (
    manifest.agent.id !== run.agentId ||
    context.agentId !== run.agentId ||
    records.length !== 1 ||
    !record ||
    (expectedId !== undefined && record.id !== expectedId) ||
    !declared ||
    !declared.enabled ||
    declared.payload.kind !== 'prompt' ||
    !declared.runtimes.includes('openclaw') ||
    record.pending ||
    record.retired ||
    record.removed ||
    record.hash !== effectiveAutomation(declared, context).hash ||
    !record.nativeHash ||
    !scheduler
  )
    throw new AutomationError('automation-lifecycle-unverified');
  const jobs = await scheduler.list({ includeDisabled: true });
  if (!Array.isArray(jobs)) throw new AutomationError('automation-observation-unavailable');
  const matches = jobs.filter(
    (job) => job?.id === run.jobId || job?.declarationKey === record.marker,
  );
  const native = matches[0];
  if (
    matches.length !== 1 ||
    !native ||
    native.id !== run.jobId ||
    native.declarationKey !== record.marker ||
    native.agentId !== run.agentId ||
    native.enabled !== true ||
    nativeAutomationHash(native) !== record.nativeHash
  )
    throw new AutomationError('automation-lifecycle-drift');
}

const namespace = 'automation-lifecycle';
type RunContextApi = {
  setRunContext(patch: {
    runId: string;
    namespace: string;
    value: AutomationLifecycleRun;
  }): boolean;
  getRunContext(params: { runId: string; namespace: string }): unknown;
  clearRunContext(params: { runId: string; namespace: string }): void;
};

/** Host-owned run context retains scheduler identity, not a hook-scoped authority handle. */
export default class AutomationLifecycleAuthority {
  constructor(private readonly contexts: RunContextApi) {}

  begin(context: RunHookContext): void {
    if (
      context.trigger !== 'cron' ||
      !context.runId ||
      !context.jobId ||
      !context.agentId ||
      !context.workspaceDir ||
      !context.sessionKey ||
      !context.sessionId
    )
      return;
    this.contexts.setRunContext({
      runId: context.runId,
      namespace,
      value: {
        runId: context.runId,
        jobId: context.jobId,
        agentId: context.agentId,
        workspaceDir: context.workspaceDir,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
      },
    });
  }

  resolve(
    context: Pick<RunHookContext, 'runId' | 'agentId' | 'sessionKey' | 'sessionId'> & {
      abortSignal?: AbortSignal;
    },
  ) {
    if (!context.runId) return;
    const stored = this.contexts.getRunContext({ runId: context.runId, namespace });
    if (!stored || typeof stored !== 'object') return;
    const run = structuredClone(stored) as AutomationLifecycleRun;
    const assertCurrent = () => {
      if (!context.abortSignal) throw new AutomationError('automation-lifecycle-unverified');
      context.abortSignal.throwIfAborted();
      const current = this.contexts.getRunContext({ runId: context.runId!, namespace });
      if (
        !current ||
        typeof current !== 'object' ||
        (['runId', 'jobId', 'agentId', 'workspaceDir', 'sessionKey', 'sessionId'] as const).some(
          (key) =>
            typeof run[key] !== 'string' ||
            !run[key] ||
            (current as Record<string, unknown>)[key] !== run[key],
        ) ||
        run.runId !== context.runId ||
        context.agentId !== run.agentId ||
        context.sessionKey !== run.sessionKey ||
        context.sessionId !== run.sessionId
      )
        throw new AutomationError('automation-lifecycle-unverified');
    };
    assertCurrent();
    return { run, assertCurrent };
  }

  end(runId: string | undefined): void {
    if (runId) this.contexts.clearRunContext({ runId, namespace });
  }
}
