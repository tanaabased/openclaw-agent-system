import { createHash } from 'node:crypto';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type { AutomationLifecycleRun } from '../agent/automations/automation-lifecycle-authority.ts';
import type { NotificationScheduler } from '../agent/automations/automation-readiness.ts';

type Context = Partial<AutomationLifecycleRun> & { trigger?: string };
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
  scheduler: () => NotificationScheduler | undefined,
  instructions: (run: AutomationLifecycleRun) => Promise<{ prompt?: string }>,
): void {
  const prepared = new Map<string, { run: Context; ready: boolean; prompt?: string }>();
  const selected = async (context: Context) => {
    if (context.trigger !== 'cron') return false;
    if (!context.jobId || !context.agentId) throw new Error('automation-prompt-binding-missing');
    const jobs = await scheduler()?.list({ includeDisabled: true });
    if (!jobs) throw new Error('automation-observation-unavailable');
    return jobs.some(
      (job) =>
        job.id === context.jobId &&
        job.agentId === context.agentId &&
        job.payload?.kind === 'agentTurn' &&
        job.declarationKey?.startsWith('agent-system:'),
    );
  };
  const matches = (run: Context, context: Context) =>
    context.trigger === 'cron' && bindingKeys.every((key) => run[key] === context[key]);
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
      prepared: !entry ? 'absent' : !entry.ready ? 'pending' : entry.prompt ? 'injected' : 'legacy',
      changed: entry ? bindingKeys.filter((key) => entry.run[key] !== context[key]) : [],
    };
    const message = `automation: code=automation-prompt-${warning ? 'load-blocked' : 'trace'} ${JSON.stringify(details)}`;
    if (warning) api.logger.warn(message);
    else api.logger.debug?.(message);
  };

  api.on('before_prompt_build', async (_event, context) => {
    trace('before_prompt_build', 'enter', context);
    const prior = context.runId ? prepared.get(context.runId) : undefined;
    if (prior) {
      trace('before_prompt_build', 'reuse', context);
      return prior.ready && matches(prior.run, context) && prior.prompt
        ? { prependContext: prior.prompt }
        : undefined;
    }
    if (context.trigger !== 'cron' || !context.runId) {
      trace('before_prompt_build', 'skip', context, 'not-cron-or-run-missing');
      return;
    }
    const entry = { run: { ...context }, ready: false, prompt: undefined as string | undefined };
    prepared.set(context.runId, entry);
    let phase = 'selection';
    try {
      if (!(await selected(context))) {
        prepared.delete(context.runId);
        trace('before_prompt_build', 'skip', context, 'unmanaged-job');
        return;
      }
      phase = 'binding';
      if (bindingKeys.some((key) => typeof context[key] !== 'string' || !context[key]))
        throw new Error('automation-prompt-binding-missing');
      phase = 'instructions';
      const result = await instructions(context as AutomationLifecycleRun);
      phase = 'lifetime';
      context.hookInvocation?.assertActive();
      if (prepared.get(context.runId) !== entry) {
        trace('before_prompt_build', 'skip', context, 'entry-replaced');
        return;
      }
      phase = 'result';
      if (result.prompt !== undefined && !result.prompt.trim())
        throw new Error('automation-prompt-instructions-missing');
      entry.prompt = result.prompt;
      entry.ready = true;
      trace('before_prompt_build', 'ready', context);
      return entry.prompt ? { prependContext: entry.prompt } : undefined;
    } catch (error) {
      // hook exceptions do not abort native runs; the input gate below enforces failure.
      trace('before_prompt_build', 'failed', context, diagnosticCode(error), true, phase);
    }
  });
  api.on('before_agent_run', async (_event, context) => {
    trace('before_agent_run', 'enter', context);
    const entry = context.runId ? prepared.get(context.runId) : undefined;
    if (entry?.ready && matches(entry.run, context)) {
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
        'Scheduled automation stopped: its job binding or instructions could not be verified. Check automation configuration and synchronize it before retrying.',
    };
  });
  api.on('agent_end', (_event, context) => {
    trace('agent_end', 'clear', context);
    if (context.runId) prepared.delete(context.runId);
  });
}
