import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type { AgentManifest } from '../manifest/types.ts';
import type AgentManifestService from '../manifest/service.ts';
import { agentCommandSecurityGuidance } from '../agent/command-security.ts';
import type AgentSystemToolRegistry from '../api/registry.ts';
import worktreeGuidance from '../agent/worktree-guidance.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'> & {
  logger?: Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
};
type HookManifestService = Pick<AgentManifestService, 'loadForRuntimeContext'>;
/** Register passive agent-aware manifest loading. */
export default function registerAgentSystemHooks(
  api: HookApi,
  manifestService: HookManifestService,
  toolRegistry: Pick<AgentSystemToolRegistry, 'guidance'>,
  turnContext?: (
    manifest: AgentManifest,
    workspace: string,
    binding: {
      agentId?: string;
      sessionKey?: string;
      sessionId?: string;
      runId?: string;
      inputId?: string;
    },
  ) => Promise<{ appendSystemContext: string; appendContext: string } | undefined>,
): void {
  api.on('session_start', async (_event, context) => {
    await manifestService.loadForRuntimeContext(context, 'session_start');
  });
  api.on('before_prompt_build', async (event, context) => {
    const result = await manifestService.loadForRuntimeContext(context, 'before_prompt_build');
    const guidance = [];
    let facts: string | undefined;
    if (result.status === 'loaded') {
      guidance.push(agentCommandSecurityGuidance, ...toolRegistry.guidance(result.manifest));
      const canonical = await worktreeGuidance(result, context);
      if (canonical) guidance.push(canonical);
      if (turnContext && context.runId) {
        try {
          const retained = await turnContext(result.manifest, result.scope.workspaceDir, {
            agentId: context.agentId,
            sessionKey: context.sessionKey,
            sessionId: context.sessionId,
            runId: context.runId,
            inputId: event.currentUserMessageId,
          });
          if (retained) {
            guidance.push(retained.appendSystemContext);
            facts = retained.appendContext;
          }
        } catch {
          guidance.push(
            'Agent System retained turn context is unavailable. Use the explicit native context tool before dependent work; do not infer authority from visible cards.',
          );
        }
      }
    }
    return guidance.length > 0
      ? { appendSystemContext: guidance.join('\n\n'), ...(facts ? { appendContext: facts } : {}) }
      : undefined;
  });
}
