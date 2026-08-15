import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from './agent-manifest-service.ts';
import { agentCommandSecurityGuidance } from './agent-command-security.ts';
import type AgentSystemToolRegistry from './tool-registry.ts';
import type GitHubNotificationPromptInstructionService from '../channels/github/lib/prompt-instruction-service.ts';
import { githubNotificationChannelId } from '../channels/github/utils/routing.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'> & {
  logger?: Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
};
type HookManifestService = Pick<AgentManifestService, 'loadForRuntimeContext'>;

/** Register passive agent-aware manifest loading. */
export default function registerAgentSystemHooks(
  api: HookApi,
  manifestService: HookManifestService,
  toolRegistry: Pick<AgentSystemToolRegistry, 'guidance'>,
  promptInstructions?: Pick<GitHubNotificationPromptInstructionService, 'clear' | 'resolve'>,
): void {
  api.on('session_start', async (_event, context) => {
    await manifestService.loadForRuntimeContext(context, 'session_start');
  });
  api.on('before_prompt_build', async (_event, context) => {
    const result = await manifestService.loadForRuntimeContext(context, 'before_prompt_build');
    const guidance =
      result.status === 'loaded'
        ? [agentCommandSecurityGuidance, ...toolRegistry.guidance(result.manifest)].join('\n')
        : undefined;
    const notificationTurn =
      context.messageProvider === githubNotificationChannelId ||
      context.channel === githubNotificationChannelId;
    const instructions = notificationTurn ? promptInstructions?.resolve(context.runId) : undefined;
    if (notificationTurn && !instructions) {
      api.logger?.warn(
        'github-notifications: prompt instructions unresolved code=github-notification-instructions-unresolved',
      );
    }
    const appendSystemContext = [guidance, instructions].filter(Boolean).join('\n\n');
    return appendSystemContext ? { appendSystemContext } : undefined;
  });
  api.on('agent_end', (_event, context) => {
    promptInstructions?.clear(context.runId);
  });
}
