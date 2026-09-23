import { realpath } from 'node:fs/promises';

import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { Value } from 'typebox/value';

import type AgentDoctorService from './doctor-service.ts';
import type AgentInstallService from './install-service.ts';
import setupStepApplies from './setup-runtime.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { lifecycleParameters, type LifecycleToolName } from '../tools/lifecycle/schema.ts';
import AgentSystemToolError from '../api/error.ts';

type LoadedManifest = Extract<AgentManifestLoadResult, { status: 'loaded' }>;
interface ApprovalContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolCallId?: string;
  abortSignal?: AbortSignal;
}
interface PendingOperation {
  loaded: LoadedManifest;
  workspaceDir: string;
  skipSetup: boolean;
  allowed: boolean;
  signal?: AbortSignal;
  expiresAt: number;
  dispose(): void;
}

function denied(): never {
  throw new AgentSystemToolError(
    'approval_denied',
    'Lifecycle approval is missing, expired, cancelled, or no longer matches this operation. Request approval again.',
  );
}

function key(name: LifecycleToolName, context: ApprovalContext): string {
  if (!context.agentId || !context.sessionKey || !context.toolCallId) denied();
  return JSON.stringify([
    name,
    context.agentId,
    context.sessionKey,
    context.sessionId ?? '',
    context.toolCallId,
  ]);
}

/** Keep host approval separate from lifecycle execution and consume consent exactly once. */
export default class AgentLifecycleApproval {
  readonly #pending = new Map<string, PendingOperation>();

  constructor(
    private readonly dependencies: {
      manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'withSnapshot'>;
      doctorService: Pick<AgentDoctorService, 'inspect'>;
      installService: Pick<AgentInstallService, 'install'>;
    },
  ) {}

  async request(
    name: LifecycleToolName,
    params: Record<string, unknown>,
    context: ApprovalContext,
  ) {
    if (!Value.Check(lifecycleParameters(name), params)) denied();
    context.abortSignal?.throwIfAborted();
    const id = key(name, context);
    this.#pending.get(id)?.dispose();
    const loaded = await this.dependencies.manifestService.loadForAgentId(
      context.agentId!,
      'before_tool_call',
    );
    if (loaded.status !== 'loaded' || loaded.manifest.agent.id !== context.agentId) denied();
    const workspaceDir = await realpath(loaded.scope.workspaceDir);
    context.abortSignal?.throwIfAborted();
    const operation = name === 'agent_system_install' ? 'Install' : 'Doctor';
    const skipSetup = params.skipSetup === true;
    const steps = skipSetup
      ? []
      : (loaded.manifest.setup?.steps ?? []).filter((step) => setupStepApplies(step, 'openclaw'));
    const description = `${operation} for agent ${JSON.stringify(loaded.manifest.agent.id)} in ${JSON.stringify(workspaceDir)}. ${name === 'agent_system_doctor' ? 'Inspect configured state and run declared checks; no repairs.' : skipSetup ? 'Reconcile configured state; skip setup.' : 'Reconcile configured state and run declared setup checks and applies.'} Manifest ${loaded.digest.slice(0, 12)}; ${steps.length} applicable setup steps.`;
    // Do not let the host's display bound silently omit the target or selected operation.
    if (description.length > 512) denied();
    const timeoutMs = 120_000;
    const pending: PendingOperation = {
      loaded: structuredClone(loaded),
      workspaceDir,
      skipSetup: params.skipSetup === true,
      allowed: false,
      signal: context.abortSignal,
      expiresAt: Date.now() + timeoutMs,
      dispose: () => {
        if (this.#pending.get(id) === pending) this.#pending.delete(id);
        clearTimeout(timer);
        context.abortSignal?.removeEventListener('abort', pending.dispose);
      },
    };
    const timer = setTimeout(() => pending.dispose(), timeoutMs);
    timer.unref();
    context.abortSignal?.addEventListener('abort', pending.dispose, { once: true });
    this.#pending.set(id, pending);
    return {
      requireApproval: {
        title: `Agent System ${operation}`,
        description,
        allowedDecisions: ['allow-once', 'deny'] as Array<'allow-once' | 'deny'>,
        timeoutMs,
        onResolution: (decision: string) => {
          // The host does not await this callback. Never execute or perform async validation here.
          if (
            decision === 'allow-once' &&
            !pending.signal?.aborted &&
            Date.now() < pending.expiresAt &&
            this.#pending.get(id) === pending
          ) {
            pending.allowed = true;
          } else pending.dispose();
        },
      },
    };
  }

  async execute(
    name: LifecycleToolName,
    params: unknown,
    toolCallId: string,
    context: OpenClawPluginToolContext,
    signal?: AbortSignal,
  ) {
    const id = key(name, { ...context, toolCallId });
    const pending = this.#pending.get(id);
    if (!pending) denied();
    pending.dispose();
    if (
      !pending.allowed ||
      Date.now() >= pending.expiresAt ||
      !Value.Check(lifecycleParameters(name), params) ||
      ((params as { skipSetup?: boolean }).skipSetup === true) !== pending.skipSetup
    )
      denied();
    const signals = [pending.signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const combinedSignal = AbortSignal.any(signals);
    const assertCurrent = async () => {
      combinedSignal.throwIfAborted();
      if (!context.workspaceDir || (await realpath(context.workspaceDir)) !== pending.workspaceDir)
        denied();
      const current = await this.dependencies.manifestService.loadForAgentId(
        context.agentId!,
        'service',
      );
      if (
        current.status !== 'loaded' ||
        current.digest !== pending.loaded.digest ||
        current.path !== pending.loaded.path ||
        current.manifest.agent.id !== context.agentId ||
        (await realpath(current.scope.workspaceDir)) !== pending.workspaceDir
      )
        denied();
      combinedSignal.throwIfAborted();
    };
    await assertCurrent();
    return this.dependencies.manifestService.withSnapshot(
      pending.loaded,
      combinedSignal,
      async () => {
        const input = {
          runtime: 'openclaw' as const,
          manifest: pending.loaded.manifest,
          workspaceDir: pending.workspaceDir,
          signal: combinedSignal,
          assertCurrent,
        };
        return name === 'agent_system_install'
          ? this.dependencies.installService.install({ ...input, skipSetup: pending.skipSetup })
          : this.dependencies.doctorService.inspect(input);
      },
    );
  }
}
