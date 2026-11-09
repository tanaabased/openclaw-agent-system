import { readCodexTaskOwner } from './codex-turn-task.ts';
import nativeFeedbackSource from './native-feedback-source.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type { ManagedIssue } from './managed-issue.ts';
import {
  assertNativeContextInput,
  isNativeContextRequest,
  isNativeFeedbackRequest,
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
  ) => Promise<
    | {
        receipt: string;
        feedbackContextRequest?: { eventId: string };
        record?: Pick<DispatchRecord, 'feedback'>;
        admission?: ManagedIssue;
      }
    | undefined
  > = readCodexTaskOwner,
) {
  if (!isNativeContextRequest(route, input)) return input;
  assertNativeContextInput(input);
  if (!threadId) throw new Error('turn-context-native-caller-required');
  const task = await read(pluginData, { threadId });
  const request = nativeContextRequest(input, task ? { id: task.receipt } : undefined);
  if (!isNativeFeedbackRequest(route, input)) return request;
  const admission = task?.admission;
  const event = nativeFeedbackSource(
    task?.record?.feedback?.events ?? [],
    task?.feedbackContextRequest?.eventId,
    admission && `${admission.repository.owner.login}/${admission.repository.name}`,
    input.source,
  );
  const { source: _source, ...authored } = request;
  return { ...authored, eventId: event.id };
}
