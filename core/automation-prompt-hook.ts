import { createHash } from 'node:crypto';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { configuredRuntime } from '../agent/models/model-configuration-plan.ts';
import type { AutomationLifecycleRun } from '../agent/automations/automation-lifecycle-authority.ts';

type Context = Partial<AutomationLifecycleRun> & {
  trigger?: string;
  modelProviderId?: string;
  modelId?: string;
};
const bindingKeys = [
  'runId',
  'jobId',
  'agentId',
  'workspaceDir',
  'sessionKey',
  'sessionId',
] as const;
const errorCodes = new Set([
  'automation-prompt-binding-missing',
  'automation-prompt-binding-unverified',
  'automation-prompt-instructions-missing',
  'automation-prompt-session-diverged',
  'automation-prompt-projection-diverged',
  'automation-observation-unavailable',
  'automation-lifecycle-unverified',
  'automation-lifecycle-drift',
  'automation-declaration-removed',
  'ENOENT',
  'EACCES',
  'EPERM',
]);

function diagnosticCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && errorCodes.has(code)) return code;
  if (error instanceof Error && errorCodes.has(error.message)) return error.message;
  return 'unclassified';
}

/** native job ownership selects injection, never the visible request or conversation title. */
export default function registerAutomationPromptHooks(
  api: Pick<OpenClawPluginApi, 'on' | 'logger'>,
  readJobs: () => Promise<
    { id: string; agentId?: string; payload?: { kind?: unknown }; declarationKey?: string }[]
  >,
  instructions: (run: AutomationLifecycleRun) => Promise<{ prompt?: string }>,
  readConfig: () => OpenClawConfig,
): void {
  const prepared = new Map<
    string,
    { run: Context; ready: boolean; projected: boolean; prompt?: string }
  >();
  const selected = async (context: Context) => {
    if (context.trigger !== 'cron') return false;
    if (!context.jobId || !context.agentId) throw new Error('automation-prompt-binding-missing');
    const jobs = await readJobs();
    if (!jobs) throw new Error('automation-observation-unavailable');
    return jobs.some(
      (job) =>
        job.id === context.jobId &&
        job.agentId === context.agentId &&
        job.payload?.kind === 'agentTurn' &&
        job.declarationKey?.startsWith('agent-system:'),
    );
  };
  const matches = (run: Context, context: Context, projection = false) =>
    context.trigger === 'cron' &&
    bindingKeys.every(
      (key) =>
        (projection && key === 'jobId' && context.jobId === undefined) || run[key] === context[key],
    );
  const trace = (
    hook: string,
    outcome: string,
    context: Context,
    reason?: string,
    warning = false,
    phase?: string,
  ) => {
    const entry = context.runId ? prepared.get(context.runId) : undefined;
    const details = {
      hook,
      outcome,
      reason,
      phase,
      trigger: context.trigger === 'cron' ? 'cron' : context.trigger ? 'other' : 'missing',
      identity: Object.fromEntries(
        bindingKeys.map((key) => [
          key,
          typeof context[key] === 'string' && context[key]
            ? createHash('sha256').update(context[key]).digest('hex').slice(0, 16)
            : null,
        ]),
      ),
      missing: bindingKeys.filter((key) => typeof context[key] !== 'string' || !context[key]),
      prepared: !entry
        ? 'absent'
        : !entry.ready
          ? 'pending'
          : !entry.projected
            ? 'loaded'
            : entry.prompt
              ? 'injected'
              : 'legacy',
      changed: entry ? bindingKeys.filter((key) => entry.run[key] !== context[key]) : [],
    };
    const message = `automation: code=automation-prompt-${warning ? 'load-blocked' : 'trace'} ${JSON.stringify(details)}`;
    if (warning) api.logger.warn(message);
    else api.logger.debug?.(message);
  };

  const stopped = (context: Context, code?: string) => {
    try {
      if (context.agentId && context.modelProviderId && context.modelId) {
        const runtime = configuredRuntime(readConfig(), context.agentId, {
          provider: context.modelProviderId,
          model: context.modelId,
        });
        // the embedded reply shortcut reports success; its input gate carries a native failure.
        if (runtime?.trim().toLowerCase() === 'openclaw') return;
      }
    } catch {
      // unavailable runtime configuration must still stop admission before inference.
    }
    if (context.runId) prepared.delete(context.runId);
    return {
      handled: true,
      reason: 'automation-prompt-load-blocked',
      reply: {
        isError: true,
        text:
          code === 'automation-declaration-removed'
            ? '> ## ❌ AUTOMATION DID NOT START\n>\n> This automation is no longer declared in agent configuration. Run Agent System Install to reconcile saved automations.'
            : 'Scheduled automation stopped (automation-prompt-load-blocked): its job binding or instructions could not be verified. Check automation configuration and synchronize it before retrying.',
      },
    };
  };
  api.on(
    'before_agent_reply',
    async (_event, context) => {
      trace('before_agent_reply', 'enter', context);
      const prior = context.runId ? prepared.get(context.runId) : undefined;
      if (prior) {
        trace('before_agent_reply', 'reuse', context);
        return prior.ready && matches(prior.run, context) ? undefined : stopped(context);
      }
      if (context.trigger !== 'cron') {
        trace('before_agent_reply', 'skip', context, 'not-cron');
        return;
      }
      const entry = {
        run: { ...context },
        ready: false,
        projected: false,
        prompt: undefined as string | undefined,
      };
      if (context.runId) prepared.set(context.runId, entry);
      let phase = 'selection';
      try {
        if (!(await selected(context))) {
          if (context.runId) prepared.delete(context.runId);
          trace('before_agent_reply', 'skip', context, 'unmanaged-job');
          return;
        }
        phase = 'binding';
        if (bindingKeys.some((key) => typeof context[key] !== 'string' || !context[key]))
          throw new Error('automation-prompt-binding-missing');
        phase = 'instructions';
        const result = await instructions(context as AutomationLifecycleRun);
        phase = 'lifetime';
        if (prepared.get(context.runId!) !== entry)
          throw new Error('automation-prompt-binding-unverified');
        phase = 'result';
        if (result.prompt !== undefined && !result.prompt.trim())
          throw new Error('automation-prompt-instructions-missing');
        entry.prompt = result.prompt;
        entry.ready = true;
        trace('before_agent_reply', 'ready', context);
      } catch (error) {
        trace('before_agent_reply', 'failed', context, diagnosticCode(error), true, phase);
        return stopped(context, diagnosticCode(error));
      }
    },
    { eligibleTriggers: ['cron'] },
  );
  api.on('before_prompt_build', (_event, context) => {
    trace('before_prompt_build', 'enter', context);
    const entry = context.runId ? prepared.get(context.runId) : undefined;
    if (!entry?.ready || !matches(entry.run, context, true)) {
      trace('before_prompt_build', 'skip', context, 'admission-missing-or-binding-changed');
      return;
    }
    context.hookInvocation?.assertActive();
    entry.projected = true;
    trace('before_prompt_build', 'reuse', context);
    return entry.prompt ? { prependContext: entry.prompt } : undefined;
  });
  api.on('before_agent_run', async (_event, context) => {
    trace('before_agent_run', 'enter', context);
    const entry = context.runId ? prepared.get(context.runId) : undefined;
    if (entry?.ready && entry.projected && matches(entry.run, context, true)) {
      trace('before_agent_run', 'pass', context);
      return { outcome: 'pass' };
    }
    let reason = entry ? 'unready-or-binding-changed' : 'prompt-hook-missing';
    try {
      if (!entry && !(await selected(context))) {
        trace('before_agent_run', 'pass', context, 'unmanaged-or-not-cron');
        return;
      }
    } catch (error) {
      // inability to observe the native job must not execute an unresolved compact request.
      reason = diagnosticCode(error);
    }
    trace('before_agent_run', 'block', context, reason);
    return {
      outcome: 'block',
      reason: 'automation-prompt-load-blocked',
      message:
        'Scheduled automation stopped (automation-prompt-load-blocked): its job binding or instructions could not be verified. Check automation configuration and synchronize it before retrying.',
    };
  });
  api.on('agent_end', (_event, context) => {
    trace('agent_end', 'clear', context);
    if (context.runId) prepared.delete(context.runId);
  });
}
