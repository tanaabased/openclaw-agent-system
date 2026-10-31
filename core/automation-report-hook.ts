import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import {
  automationReportCardValid,
  automationReportInstructions,
} from '../agent/automation-report.ts';
import type AutomationReportStore from '../agent/automation-report-store.ts';
import type { AutomationReportRecord } from '../agent/automation-report-store.ts';

/** only retained native run identities select a formatter turn; prompt prose never does. */
export default function registerAutomationReportHooks(
  api: Pick<OpenClawPluginApi, 'on'>,
  store: AutomationReportStore,
  reconcile: (id?: string) => Promise<void>,
) {
  async function selected(context: {
    runId?: string;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
  }): Promise<AutomationReportRecord | undefined> {
    if (!context.runId || !/^[a-f0-9-]{36}$/.test(context.runId)) return;
    const record = await store.read(context.runId);
    if (
      !record ||
      record.target.agentId !== context.agentId ||
      record.target.sessionKey !== context.sessionKey ||
      record.target.sessionId !== context.sessionId
    )
      return;
    return record;
  }
  api.on('before_prompt_build', async (_event, context) => {
    const record = await selected(context);
    if (!record) return;
    await store.update(record.executionId, (current) => {
      current.guarded = true;
    });
    return { toolsAllow: [], appendSystemContext: automationReportInstructions };
  });
  api.on('before_tool_call', async (event, context) => {
    try {
      if (!(await selected({ ...context, runId: context.runId ?? event.runId }))) return;
    } catch {
      // unreadable custody cannot silently remove a retained formatter's tool restriction.
      return {
        block: true,
        blockReason: 'Automation report custody is unavailable; retry after storage recovery.',
      };
    }
    return {
      block: true,
      blockReason:
        'Automation reporting is formatting only; tools and command replay are disabled for this turn.',
    };
  });
  api.on('llm_output', async (event, context) => {
    const record = await selected({ ...context, runId: event.runId });
    if (!record) return;
    await store.update(record.executionId, (current) => {
      current.effective = {
        model: event.resolvedRef ?? `${event.provider}/${event.model}`,
        ...(event.reasoningEffort ? { effort: event.reasoningEffort } : {}),
        ...(event.harnessId ? { harness: event.harnessId } : {}),
      };
    });
  });
  api.on('before_agent_finalize', async (event, context) => {
    const record = await selected({ ...context, runId: context.runId ?? event.runId });
    if (!record || automationReportCardValid(event.lastAssistantMessage ?? '', record.input))
      return;
    // one bounded correction pass, never a repair loop or a transcript rewrite.
    return {
      action: 'revise',
      reason: 'automation-report-card-invalid',
      retry: {
        instruction: `${automationReportInstructions}\nRequired run line: ${record.input.runLine}\nRunner outcome: ${record.input.outcome}.`,
        idempotencyKey: `automation-report:${record.executionId}`,
        maxAttempts: 1,
      },
    };
  });
  api.on('agent_end', async (event, context) => {
    const record = await selected({ ...context, runId: context.runId ?? event.runId });
    if (!record) return;
    if (!event.success)
      await store.update(record.executionId, (current) => {
        current.state = 'failed';
        current.code = 'automation-report-model-failed';
      });
    await reconcile(record.executionId);
  });
  api.on('cron_changed', async (event) => {
    if (event.action === 'finished') await reconcile();
  });
  api.on('cron_reconciled', async () => {
    await reconcile();
  });
}
