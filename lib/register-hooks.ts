import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from './agent-manifest-service.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'>;
type HookManifestService = Pick<AgentManifestService, 'loadForRuntimeContext'>;

/** Register passive agent-aware manifest loading. */
export default function registerAgentSystemHooks(
  api: HookApi,
  manifestService: HookManifestService,
): void {
  api.on('session_start', async (_event, context) => {
    await manifestService.loadForRuntimeContext(context, 'session_start');
  });
}
