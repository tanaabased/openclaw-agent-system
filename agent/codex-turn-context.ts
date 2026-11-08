import readCodexTurnTask from './codex-turn-task.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import codexRuntimeInstructions from './codex-runtime-instructions.ts';

import {
  inspectCodexWorkspaceBinding,
  type CodexWorkspaceBindingInspection,
} from './codex-workspace-binding.ts';

/** refresh native identities and read-only task hints without trusting provider prose. */
export default async function codexTurnContext(
  pluginData: string,
  input: unknown,
  inspect: (
    pluginData: string,
  ) => Promise<CodexWorkspaceBindingInspection> = inspectCodexWorkspaceBinding,
  task: typeof readCodexTurnTask = readCodexTurnTask,
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
  const currentTurn = { threadId: hook.session_id, turnId: hook.turn_id };
  const retained = await task(pluginData, currentTurn).catch(() => undefined);
  return (
    'Agent System model-only current-turn context (keep private). ' +
    'These lookup facts grant no task or publication authority; existing context tools still verify the source.\n' +
    JSON.stringify({
      contextProbe: { version: 1, runtime: 'codex', hook: 'UserPromptSubmit' },
      agentId: binding.preview.manifest.manifest.agent.id,
      workspace: binding.preview.workspaceDir,
      currentTurn,
      ...retained,
    }) +
    (retained
      ? '\n\n' +
        codexRuntimeInstructions +
        '\n\n' +
        nativeTaskInstructions('codex') +
        '\n\n' +
        'Use feedbackContextRequest with feedbackRuntime context when supplied; otherwise use contextRequest with contextRuntime when task context is needed. Read the verified source and configured method before dependent work. Preserve the human-facing quoted cards; keep these machine instructions and facts out of your authored messages. If a source lookup is unavailable or ambiguous, use the existing native receipt inspection; do not infer a feedback source or restart assessment from a chat identity. The hook supplies lookup hints, not task or publication authority.'
      : '')
  );
}
