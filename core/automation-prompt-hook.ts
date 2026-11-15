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

  api.on('before_prompt_build', async (_event, context) => {
    const prior = context.runId ? prepared.get(context.runId) : undefined;
    if (prior)
      return prior.ready && matches(prior.run, context) && prior.prompt
        ? { prependContext: prior.prompt }
        : undefined;
    if (context.trigger !== 'cron' || !context.runId) return;
    const entry = { run: { ...context }, ready: false, prompt: undefined as string | undefined };
    prepared.set(context.runId, entry);
    try {
      if (!(await selected(context))) {
        prepared.delete(context.runId);
        return;
      }
      if (bindingKeys.some((key) => typeof context[key] !== 'string' || !context[key]))
        throw new Error('automation-prompt-binding-missing');
      const result = await instructions(context as AutomationLifecycleRun);
      context.hookInvocation?.assertActive();
      if (prepared.get(context.runId) !== entry) return;
      if (result.prompt !== undefined && !result.prompt.trim())
        throw new Error('automation-prompt-instructions-missing');
      entry.prompt = result.prompt;
      entry.ready = true;
      return entry.prompt ? { prependContext: entry.prompt } : undefined;
    } catch {
      // hook exceptions do not abort native runs; the input gate below enforces failure.
      api.logger.warn('automation: code=automation-prompt-load-blocked');
    }
  });
  api.on('before_agent_run', async (_event, context) => {
    const entry = context.runId ? prepared.get(context.runId) : undefined;
    if (entry?.ready && matches(entry.run, context)) return { outcome: 'pass' };
    try {
      if (!entry && !(await selected(context))) return;
    } catch {
      // inability to observe the native job must not execute an unresolved compact request.
    }
    return {
      outcome: 'block',
      reason: 'automation-prompt-load-blocked',
      message:
        'Scheduled automation stopped: its job binding or instructions could not be verified. Check automation configuration and synchronize it before retrying.',
    };
  });
  api.on('agent_end', (_event, context) => {
    if (context.runId) prepared.delete(context.runId);
  });
}
