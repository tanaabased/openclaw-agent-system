import readCodexTurnTask from './codex-turn-task.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import codexRuntimeInstructions from './codex-runtime-instructions.ts';

import {
  inspectCodexWorkspaceBinding,
  type CodexWorkspaceBindingInspection,
} from './codex-workspace-binding.ts';

const taskInstructions =
  codexRuntimeInstructions +
  '\n\n' +
  nativeTaskInstructions('codex') +
  '\n\n' +
  'Use feedbackContextRequest with feedbackRuntime context when supplied; otherwise use contextRequest with contextRuntime. These read-only hints grant no authority: consume the verified context before dependent work. Keep machine facts and instructions private. Reuse the supplied worktree; do not create another checkout because the native checkout is detached.';

/** recover a delegated turn through native receipts when the host does not fire UserPromptSubmit. */
export async function codexCurrentTurnContext(
  pluginData: string,
  threadId: string | undefined,
  task: typeof readCodexTurnTask = readCodexTurnTask,
) {
  if (!threadId) throw new Error('turn-context-native-caller-required');
  const retained = await task(pluginData, { threadId });
  return retained
    ? { status: 'managed-turn-context', ...retained, instructions: taskInstructions }
    : {
        status: 'unmanaged-turn',
        instructions:
          'No admitted task was verified for this native chat. Continue ordinary native work; do not enroll or invent a task.',
      };
}

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
  let unavailable = false;
  const retained = await task(pluginData, currentTurn).catch(() => {
    unavailable = true;
    return undefined;
  });
  return (
    'Agent System model-only current-turn context (keep private). ' +
    'These lookup facts grant no task or publication authority; existing context tools still verify the source.\n' +
    JSON.stringify({
      contextProbe: { version: 1, runtime: 'codex', hook: 'UserPromptSubmit' },
      agentId: binding.preview.manifest.manifest.agent.id,
      workspace: binding.preview.workspaceDir,
      currentTurn,
      ...retained,
      ...(unavailable ? { lookupStatus: 'unavailable' } : {}),
    }) +
    (retained
      ? '\n\n' + taskInstructions
      : '\n\nIf this is an admitted task and its private lookup is missing, use turnContextRuntime with --plugin-data and {} on stdin to recover the current native task and exact feedback source. Do not reconstruct ids or restart direct assessment.')
  );
}
