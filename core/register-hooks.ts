import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from '../manifest/service.ts';
import { agentCommandSecurityGuidance } from '../agent/command-security.ts';
import type AgentSystemToolRegistry from '../api/registry.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'> & {
  logger?: Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
};
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
    const guidance = [];
    if (result.status === 'loaded') {
      guidance.push(agentCommandSecurityGuidance, ...toolRegistry.guidance(result.manifest));
    }
    return guidance.length > 0 ? { appendSystemContext: guidance.join('\n\n') } : undefined;
  });
}
