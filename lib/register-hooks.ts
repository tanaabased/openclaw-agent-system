import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from './agent-manifest-service.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'>;
type HookManifestService = Pick<AgentManifestService, 'loadForRuntimeContext'>;

/** Register passive manifest loading at the earliest agent-aware runtime boundaries. */
export default function registerAgentSystemHooks(
  api: HookApi,
  manifestService: HookManifestService,
): void {
  api.on('session_start', async (_event, context) => {
    await manifestService.loadForRuntimeContext(context, 'session_start');
  });

  api.on('before_tool_call', async (_event, context) => {
    await manifestService.loadForRuntimeContext(context, 'before_tool_call');
  });
}
