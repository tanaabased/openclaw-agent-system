import { createHash } from 'node:crypto';

import type AutomationService from './automation-service.ts';
import type { NotificationScheduler } from './automation-readiness.ts';
import {
  AutomationError,
  listNativeAutomations,
  type AutomationGateway,
} from './automation-gateway.ts';
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
  request?: AutomationGateway,
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
    !record.nativeHash
  )
    throw new AutomationError('automation-lifecycle-unverified');
  if (!scheduler && !request) throw new AutomationError('automation-observation-unavailable');
  const jobs = scheduler
    ? await scheduler.list({ includeDisabled: true })
    : await listNativeAutomations(request!);
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

/** retain native scheduler facts alongside this instance's native tool-call bindings. */
export default class AutomationLifecycleAuthority {
  readonly #runs = new Map<string, AutomationLifecycleRun>();

  constructor(private readonly logger?: { debug?(message: string): void }) {}

  private trace(stage: string, context: RunHookContext, outcome: string): void {
    if (!this.logger?.debug) return;
    const identity = Object.fromEntries(
      (['runId', 'jobId', 'agentId', 'workspaceDir', 'sessionKey', 'sessionId'] as const).map(
        (key) => [
          key,
          typeof context[key] === 'string' && context[key]
            ? createHash('sha256').update(context[key]).digest('hex').slice(0, 16)
            : null,
        ],
      ),
    );
    this.logger.debug(
      `automation: code=automation-lifecycle-${stage} outcome=${outcome} cron=${context.trigger === 'cron'} identity=${JSON.stringify(identity)}`,
    );
  }

  begin(context: RunHookContext): void {
    if (
      context.trigger !== 'cron' ||
      !context.runId ||
      !context.jobId ||
      !context.agentId ||
      !context.workspaceDir ||
      !context.sessionKey ||
      !context.sessionId
    ) {
      this.trace('begin', context, 'incomplete-or-not-cron');
      return;
    }
    this.#runs.set(context.runId, {
      runId: context.runId,
      jobId: context.jobId,
      agentId: context.agentId,
      workspaceDir: context.workspaceDir,
      sessionKey: context.sessionKey,
      sessionId: context.sessionId,
    });
    this.trace('begin', context, 'stored');
  }

  resolve(
    context: Pick<RunHookContext, 'runId' | 'agentId' | 'sessionKey' | 'sessionId'> & {
      abortSignal?: AbortSignal;
    },
  ) {
    if (!context.runId) {
      this.trace('resolve', context, 'run-id-missing');
      return;
    }
    const stored = this.#runs.get(context.runId);
    this.trace('resolve', context, stored && typeof stored === 'object' ? 'found' : 'missing');
    if (!stored || typeof stored !== 'object') return;
    const run = structuredClone(stored) as AutomationLifecycleRun;
    const assertCurrent = () => {
      if (!context.abortSignal) throw new AutomationError('automation-lifecycle-unverified');
      context.abortSignal.throwIfAborted();
      const current = this.#runs.get(context.runId!);
      if (
        !current ||
        typeof current !== 'object' ||
        (['runId', 'jobId', 'agentId', 'workspaceDir', 'sessionKey', 'sessionId'] as const).some(
          (key) => typeof run[key] !== 'string' || !run[key] || current[key] !== run[key],
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
    this.trace('end', { runId }, 'clear');
    if (runId) this.#runs.delete(runId);
  }
}
