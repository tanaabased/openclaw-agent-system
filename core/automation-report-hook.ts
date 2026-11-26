import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import {
  automationReportCardValid,
  automationReportInstructionsFor,
  default as automationReport,
} from '../agent/automations/automation-report.ts';
import type AutomationReportStore from '../agent/automations/automation-report-store.ts';
import type AutomationService from '../agent/automations/automation-service.ts';

/** only retained native run identities select a formatter turn; prompt prose never does. */
export default function registerAutomationReportHooks(
  api: Pick<OpenClawPluginApi, 'on' | 'logger'>,
  reports: Pick<AutomationService, 'reportStore' | 'reportStores'>,
  reconcile: (store: AutomationReportStore, id: string) => Promise<void>,
) {
  async function selected(
    context: {
      runId?: string;
      agentId?: string;
      sessionKey?: string;
      sessionId?: string;
    },
    hook?: string,
  ) {
    if (!context.runId || !/^[a-f0-9-]{36}$/.test(context.runId)) {
      if (hook)
        api.logger.debug?.(
          `automation report hook: ${JSON.stringify({ hook, runIdValid: false })}`,
        );
      return;
    }
    if (!context.agentId) return;
    const store = await reports.reportStore(context.agentId);
    const record = await store.read(context.runId);
    if (hook)
      api.logger.debug?.(
        `automation report hook: ${JSON.stringify({
          hook,
          runId: context.runId,
          recordFound: Boolean(record),
          agentMatches: Boolean(record && record.target.agentId === context.agentId),
          sessionKeyMatches: Boolean(record && record.target.sessionKey === context.sessionKey),
          sessionIdMatches: Boolean(record && record.target.sessionId === context.sessionId),
        })}`,
      );
    if (
      !record ||
      record.target.agentId !== context.agentId ||
      record.target.sessionKey !== context.sessionKey ||
      record.target.sessionId !== context.sessionId
    )
      return;
    return { record, store };
  }
  api.on('before_prompt_build', async (_event, context) => {
    const match = await selected(context, 'before_prompt_build');
    if (!match) return;
    const { record, store } = match;
    await store.update(record.executionId, (current, nowMs) => {
      current.guarded = true;
      (current.timing ??= {}).formatterStartedAtMs ??= nowMs;
    });
    // codex rejects restrictive prompt-hook allowlists; block execution below instead.
    return {
      appendSystemContext: automationReportInstructionsFor(record.input),
      prependContext: automationReport(record.input),
    };
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
    const match = await selected({ ...context, runId: event.runId });
    if (!match) return;
    const { record, store } = match;
    await store.update(record.executionId, (current) => {
      current.effective = {
        model: event.resolvedRef ?? `${event.provider}/${event.model}`,
        ...(event.reasoningEffort ? { effort: event.reasoningEffort } : {}),
        ...(event.harnessId ? { harness: event.harnessId } : {}),
      };
    });
  });
  api.on('before_agent_finalize', async (event, context) => {
    const match = await selected(
      { ...context, runId: context.runId ?? event.runId },
      'before_agent_finalize',
    );
    if (!match) return;
    const { record } = match;
    const valid = automationReportCardValid(event.lastAssistantMessage ?? '', record.input);
    api.logger.debug?.(
      `automation report hook: ${JSON.stringify({
        hook: 'finalize-validation',
        runId: record.executionId,
        responsePresent: Boolean(event.lastAssistantMessage),
        valid,
        correctionRequested: !valid,
      })}`,
    );
    if (valid) return;
    // one bounded correction pass, never a repair loop or a transcript rewrite.
    return {
      action: 'revise',
      reason: 'automation-report-card-invalid',
      retry: {
        instruction: `Replace the rejected response in full. Do not continue it, explain the correction, or append another copy.\n\n${automationReport(record.input)}`,
        idempotencyKey: `automation-report:${record.executionId}`,
        maxAttempts: 1,
      },
    };
  });
  api.on('agent_end', async (event, context) => {
    const match = await selected({ ...context, runId: context.runId ?? event.runId });
    if (!match) return;
    const { record, store } = match;
    if (!event.success)
      await store.update(record.executionId, (current) => {
        if (current.state === 'delivered' || current.state === 'failed') return;
        current.state = 'failed';
        current.code = 'automation-report-model-failed';
      });
    await reconcile(store, record.executionId);
  });
  async function recover() {
    for await (const store of reports.reportStores()) {
      try {
        for (const id of await store.recoveryIds()) await reconcile(store, id);
      } catch {
        api.logger.warn('automation-report: recovery-unavailable');
      }
      try {
        await store.prune();
      } catch {
        api.logger.warn('automation-report: cleanup-unavailable');
      }
    }
  }
  api.on('cron_changed', async (event) => {
    if (event.action === 'finished') await recover();
  });
  api.on('cron_reconciled', recover);
}
