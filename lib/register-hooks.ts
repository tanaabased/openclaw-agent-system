import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { githubNotificationChannelId } from '../channels/github/utils/routing.ts';
import { githubNotificationTurnInstructions } from '../channels/github/utils/turn-presentation.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import { agentCommandSecurityGuidance } from './agent-command-security.ts';
import type AgentSystemToolRegistry from './tool-registry.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'>;
type HookManifestService = Pick<AgentManifestService, 'loadForRuntimeContext'>;

/** Register passive agent-aware manifest loading. */
export default function registerAgentSystemHooks(
  api: HookApi,
  manifestService: HookManifestService,
  toolRegistry: Pick<AgentSystemToolRegistry, 'guidance'>,
): void {
  api.on('session_start', async (_event, context) => {
    await manifestService.loadForRuntimeContext(context, 'session_start');
  });
  api.on('before_prompt_build', async (event, context) => {
    const result = await manifestService.loadForRuntimeContext(context, 'before_prompt_build');
    if (result.status !== 'loaded') return;

    const guidance = [agentCommandSecurityGuidance, ...toolRegistry.guidance(result.manifest)];
    if (
      [context.messageProvider, context.channel, context.channelId].includes(
        githubNotificationChannelId,
      )
    ) {
      const turnInstructions = githubNotificationTurnInstructions(event.prompt);
      if (turnInstructions) guidance.push(turnInstructions);
    }
    return { appendSystemContext: guidance.join('\n') };
  });
}
