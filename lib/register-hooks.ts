import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentEnvironmentService from './agent-environment-service.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'>;
type HookEnvironmentService = Pick<AgentEnvironmentService, 'loadForRuntimeContext'>;

function blockReason(
  result: Awaited<ReturnType<HookEnvironmentService['loadForRuntimeContext']>>,
): string {
  if (result.status === 'invalid') {
    const codes = result.diagnostics.map(({ code }) => code).join(', ');
    return `Agent System blocked exec because the active manifest is invalid${codes ? ` (${codes})` : ''}.`;
  }
  return 'Agent System blocked exec because the active agent workspace could not be resolved.';
}

/** Register agent-aware manifest loading and exec environment delivery. */
export default function registerAgentSystemHooks(
  api: HookApi,
  environmentService: HookEnvironmentService,
): void {
  api.on('session_start', async (_event, context) => {
    await environmentService.loadForRuntimeContext(context, 'session_start');
  });

  api.on('before_tool_call', async (event, context) => {
    const result = await environmentService.loadForRuntimeContext(context, 'before_tool_call');
    if (event.toolName !== 'exec') return;
    if (result.status === 'unresolved' || result.status === 'invalid') {
      return { block: true, blockReason: blockReason(result) };
    }
  });

  api.on('resolve_exec_env', async (_event, context) => {
    const result = await environmentService.loadForRuntimeContext(context, 'resolve_exec_env');
    if (result.status !== 'loaded') return;
    return result.environment.values;
  });
}
