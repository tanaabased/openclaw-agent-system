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
  const { job, native, installedPrompt } = await verifyAutomationLifecycleRun(
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
  if (payload.message === installedRequest) return { prompt };
  // already-installed full prompts remain valid until explicit synchronization.
  if (payload.message === prompt.trim()) return {};
  throw new AutomationError('automation-prompt-projection-diverged');
}
