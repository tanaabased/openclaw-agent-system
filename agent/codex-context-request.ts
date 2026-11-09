import readCodexTurnTask from './codex-turn-task.ts';
import {
  assertNativeContextInput,
  isNativeContextRequest,
  nativeContextRequest,
} from './native-context-request.ts';

/** current native caller evidence selects the task; ordinary workflow owners still authorize it. */
export default async function codexContextRequest(
  pluginData: string,
  route: string,
  input: Record<string, unknown>,
  threadId = process.env.CODEX_THREAD_ID,
  read: (
    pluginData: string,
    turn: { threadId: string },
  ) => Promise<{ receipt: string } | undefined> = readCodexTurnTask,
) {
  if (!isNativeContextRequest(route, input)) return input;
  assertNativeContextInput(input);
  if (!threadId) throw new Error('turn-context-native-caller-required');
  const task = await read(pluginData, { threadId });
  return nativeContextRequest(input, task ? { id: task.receipt } : undefined);
}
