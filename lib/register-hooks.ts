import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from './agent-manifest-service.ts';
import { agentCommandSecurityGuidance } from './agent-command-security.ts';
import type AgentSystemToolRegistry from './tool-registry.ts';
import resolveGitHubNotificationMessage, {
  parseGitHubNotificationMessageRequest,
} from '../channels/github/lib/message-registry.ts';
import { githubNotificationChannelId } from '../channels/github/utils/routing.ts';

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
  api.on('before_prompt_build', async (_event, context) => {
    const result = await manifestService.loadForRuntimeContext(context, 'before_prompt_build');
    const guidance =
      result.status === 'loaded'
        ? [agentCommandSecurityGuidance, ...toolRegistry.guidance(result.manifest)].join('\n')
        : undefined;
    const request =
      context.messageProvider === githubNotificationChannelId
        ? parseGitHubNotificationMessageRequest(
            context.channelContext?.agentSystemGitHubNotification,
          )
        : undefined;
    const instructions = request
      ? resolveGitHubNotificationMessage(request).instructions
      : undefined;
    const appendSystemContext = [guidance, instructions].filter(Boolean).join('\n\n');
    return appendSystemContext ? { appendSystemContext } : undefined;
  });
}
