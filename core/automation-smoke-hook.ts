import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { automationSmokeTestId } from '../agent/automations/automation-smoke-test.ts';
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

export default function registerAutomationSmokeHooks(
  api: Pick<OpenClawPluginApi, 'on' | 'logger'>,
  scheduler: () => NotificationScheduler | undefined,
  instructions: (run: AutomationLifecycleRun) => Promise<string>,
): void {
  const prepared = new Map<string, { run?: AutomationLifecycleRun; prompt?: string }>();
  const selected = async (context: Context) => {
    if (context.trigger !== 'cron' || !context.jobId || !context.agentId) return false;
    try {
      const jobs = await scheduler()?.list({ includeDisabled: true });
      return (
        jobs?.some(
          (job) =>
            job.id === context.jobId &&
            job.agentId === context.agentId &&
            job.declarationKey?.startsWith('agent-system:') &&
            job.declarationKey.endsWith(`:${automationSmokeTestId}`),
        ) ?? false
      );
    } catch {
      // unknown jobs gain no smoke instructions; do not gate unrelated cron work.
      api.logger.debug?.('automation-smoke: selection-unavailable');
      return false;
    }
  };
  const matches = (run: AutomationLifecycleRun | undefined, context: Context) =>
    run && context.trigger === 'cron' && bindingKeys.every((key) => run[key] === context[key]);

  api.on('before_prompt_build', async (_event, context) => {
    const prior = context.runId ? prepared.get(context.runId) : undefined;
    if (prior)
      return matches(prior.run, context) && prior.prompt
        ? { prependContext: prior.prompt }
        : undefined;
    if (!(await selected(context))) return;
    if (!context.runId) return;
    // retain failure before loading: prompt-hook failures alone do not abort OpenClaw runs.
    const entry: { run?: AutomationLifecycleRun; prompt?: string } = {};
    prepared.set(context.runId, entry);
    try {
      if (bindingKeys.some((key) => typeof context[key] !== 'string' || !context[key]))
        throw new Error('automation-smoke-binding-missing');
      const run = Object.fromEntries(
        bindingKeys.map((key) => [key, context[key]]),
      ) as unknown as AutomationLifecycleRun;
      const prompt = await instructions(run);
      context.hookInvocation?.assertActive();
      if (!prompt.trim()) throw new Error('automation-smoke-instructions-missing');
      entry.run = run;
      entry.prompt = prompt;
      return { prependContext: prompt };
    } catch {
      api.logger.warn('automation-smoke: instruction-load-blocked');
    }
  });
  api.on('before_agent_run', async (_event, context) => {
    const entry = context.runId ? prepared.get(context.runId) : undefined;
    if (!entry && !(await selected(context))) return;
    if (matches(entry?.run, context) && entry?.prompt) return { outcome: 'pass' };
    return {
      outcome: 'block',
      reason: 'automation-smoke-instruction-load-blocked',
      message:
        'Compact prompt smoke test stopped: its run binding or instructions could not be verified.',
    };
  });
  api.on('llm_output', (event, context) => {
    const binding = { ...context, runId: event.runId };
    if (!matches(prepared.get(event.runId)?.run, binding)) return;
    api.logger.info(
      `automation-smoke: runtime ${JSON.stringify({
        runId: event.runId,
        harness: event.harnessId,
        provider: event.provider,
        model: event.model,
      })}`,
    );
  });
  api.on('before_tool_call', (event, context) => {
    const runId = context.runId ?? event.runId;
    if (!runId || !prepared.has(runId)) return;
    return {
      block: true,
      blockReason:
        'The compact prompt smoke test assesses synthetic evidence only; tools are disabled for this run.',
    };
  });
  api.on('agent_end', (_event, context) => {
    if (context.runId) prepared.delete(context.runId);
  });
}
