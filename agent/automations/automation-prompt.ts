import intakeAutomationNotice from '../../channels/github/presentation/intake-automation-notice.ts';
import { renderStructuredReport } from './automation-report-presentation.ts';
import { automationPromptRequest } from './automation-projection.ts';
import type { AgentManifest } from '../../manifest/types.ts';
import type AutomationService from './automation-service.ts';
import {
  verifyAutomationLifecycleRun,
  type AutomationLifecycleRun,
} from './automation-lifecycle-authority.ts';
import type { NotificationScheduler } from './automation-readiness.ts';
import { AutomationError } from './automation-errors.ts';
import type { AutomationGateway } from './automation-gateway.ts';

export async function resolveAutomationPrompt(
  service: Pick<AutomationService, 'scope'>,
  scheduler: NotificationScheduler | undefined,
  manifest: AgentManifest,
  run: AutomationLifecycleRun,
  request?: AutomationGateway,
): Promise<{ prompt?: string }> {
  const { job, native, installedPrompt, configurationDrift } = await verifyAutomationLifecycleRun(
    service,
    scheduler,
    manifest,
    run,
    undefined,
    request,
    true,
    true,
  );
  const payload = native.payload;
  const prompt =
    installedPrompt ?? (job?.payload.kind === 'prompt' ? job.payload.prompt : undefined);
  if (prompt === undefined || payload?.kind !== 'agentTurn' || !('message' in payload))
    throw new AutomationError('automation-prompt-instructions-missing');
  if (
    typeof native.sessionTarget === 'string' &&
    native.sessionTarget.startsWith('session:') &&
    native.sessionTarget.slice(8) !== run.sessionKey
  )
    throw new AutomationError('automation-prompt-session-diverged');
  const installedRequest = automationPromptRequest({
    id: job?.id ?? native.declarationKey!.split(':').at(-1)!,
    displayName:
      'displayName' in native && typeof native.displayName === 'string'
        ? native.displayName
        : undefined,
  });
  if (payload.message !== installedRequest && payload.message !== prompt.trim())
    throw new AutomationError('automation-prompt-projection-diverged');
  const notice =
    configurationDrift &&
    job &&
    intakeAutomationNotice('intake-automation-update-required', job.id);
  if (notice) {
    const card = renderStructuredReport(
      {
        id: 'configuration-drift',
        format: 'structured',
        status: 'warning',
        title: notice.title,
        summary: notice.summary,
        actions: [notice.next],
      },
      notice.emoji,
    );
    return {
      prompt: [
        payload.message === installedRequest ? prompt : '',
        'Include this update notice verbatim alongside your final response:',
        card,
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
  }
  if (payload.message === installedRequest) return { prompt };
  // already-installed full prompts remain valid until explicit synchronization.
  return {};
}
