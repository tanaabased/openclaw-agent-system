import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentManifestService from '../manifest/service.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { agentCommandSecurityGuidance } from '../agent/command-security.ts';
import type AgentSystemToolRegistry from '../api/registry.ts';
import type { AgentSystemHookContext } from './agent-hook-context.ts';
import worktreeGuidance from '../agent/worktree-guidance.ts';

type HookApi = Pick<OpenClawPluginApi, 'on'> & {
  logger?: Pick<OpenClawPluginApi['logger'], 'info' | 'warn'>;
};
type HookManifestService = Pick<AgentManifestService, 'loadForRuntimeContext'>;
export interface AgentSystemPromptGuidance {
  beforeRun?(
    context: AgentSystemHookContext,
    manifest?: AgentManifest,
  ): Promise<
    | {
        outcome: 'block';
        reason: string;
        message: string;
      }
    | undefined
  >;
  instructions(
    context: AgentSystemHookContext,
    manifest?: AgentManifest,
  ): string | undefined | Promise<string | undefined>;
}

/** Register passive agent-aware manifest loading. */
export default function registerAgentSystemHooks(
  api: HookApi,
  manifestService: HookManifestService,
  toolRegistry: Pick<AgentSystemToolRegistry, 'guidance'>,
  promptGuidance?: AgentSystemPromptGuidance,
): void {
  if (promptGuidance?.beforeRun) {
    api.on('before_agent_run', async (_event, context) => {
      const result = await manifestService.loadForRuntimeContext(context, 'service');
      return promptGuidance.beforeRun!(
        context,
        result.status === 'loaded' ? result.manifest : undefined,
      );
    });
  }
  api.on('session_start', async (_event, context) => {
    await manifestService.loadForRuntimeContext(context, 'session_start');
  });
  api.on('before_prompt_build', async (_event, context) => {
    const result = await manifestService.loadForRuntimeContext(context, 'before_prompt_build');
    const guidance = [];
    if (result.status === 'loaded') {
      guidance.push(agentCommandSecurityGuidance, ...toolRegistry.guidance(result.manifest));
      const canonical = await worktreeGuidance(result, context);
      if (canonical) guidance.push(canonical);
    }
    const promptInstructions = await promptGuidance?.instructions(
      context,
      result.status === 'loaded' ? result.manifest : undefined,
    );
    if (promptInstructions) guidance.push(promptInstructions);
    return guidance.length > 0 ? { appendSystemContext: guidance.join('\n\n') } : undefined;
  });
}
