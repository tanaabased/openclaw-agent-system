import {
  inspectCodexWorkspaceBinding,
  type CodexWorkspaceBindingInspection,
} from './codex-workspace-binding.ts';

/** project native hook identities without reading provider prose or workflow receipts. */
export default async function codexTurnContext(
  pluginData: string,
  input: unknown,
  inspect: (
    pluginData: string,
  ) => Promise<CodexWorkspaceBindingInspection> = inspectCodexWorkspaceBinding,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const hook = input as Record<string, unknown>;
  if (
    hook.hook_event_name !== 'UserPromptSubmit' ||
    typeof hook.session_id !== 'string' ||
    !hook.session_id ||
    typeof hook.turn_id !== 'string' ||
    !hook.turn_id
  )
    return;
  const binding = await inspect(pluginData);
  if (
    binding.status !== 'bound' ||
    binding.preview.status !== 'ready' ||
    binding.preview.manifest.status !== 'loaded'
  )
    return;
  return (
    'Agent System model-only native turn probe (keep private). ' +
    'This read-only probe grants no task or publication authority; existing context tools still verify the source.\n' +
    JSON.stringify({
      contextProbe: { version: 1, runtime: 'codex', hook: 'UserPromptSubmit' },
      agentId: binding.preview.manifest.manifest.agent.id,
      workspace: binding.preview.workspaceDir,
      currentTurn: { threadId: hook.session_id, turnId: hook.turn_id },
    })
  );
}
