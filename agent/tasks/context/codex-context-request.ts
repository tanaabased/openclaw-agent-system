import { readCodexTaskOwner } from './codex-turn-task.ts';
import codexDispatchBinding, {
  codexFeedbackReconciliation,
  codexFeedbackPublication,
} from '../dispatch/codex-dispatch-binding.ts';
import { isNativeDispatchSelection } from '../dispatch/native-dispatch-selection.ts';
import nativeFeedbackSource from '../feedback/native-feedback-source.ts';
import type { DispatchRecord } from '../dispatch/codex-dispatch-state.ts';
import type { ManagedIssue } from '../managed-issue.ts';
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
  if (route === 'feedback' && input.action === 'publish-approved') {
    assertNativeContextInput(input);
    if (!threadId) throw new Error('turn-context-native-caller-required');
    return codexFeedbackPublication(pluginData, input, threadId);
  }
  if (route === 'continuation' && input.action === 'reconcile') {
    assertNativeContextInput(input);
    if (!threadId) throw new Error('turn-context-native-caller-required');
    return codexDispatchBinding(pluginData, input, threadId);
  }
  if (
    route === 'dispatch' &&
    (isNativeDispatchSelection(input.action) ||
      input.action === 'report' ||
      input.action === 'retire' ||
      ['recover', 'reset', 'retry-denied'].includes(String(input.action)))
  ) {
    assertNativeContextInput(input);
    if (!threadId) throw new Error('turn-context-native-caller-required');
    return codexDispatchBinding(pluginData, input, threadId);
  }
  if (!isNativeContextRequest(route, input)) return input;
  assertNativeContextInput(input);
  if (!threadId) throw new Error('turn-context-native-caller-required');
  const task = await read(pluginData, { threadId });
  if (!task && route === 'feedback' && input.action === 'reconcile')
    return codexFeedbackReconciliation(pluginData, input, threadId);
  const request = nativeContextRequest(input, task ? { id: task.receipt } : undefined);
  if (!isNativeFeedbackRequest(route, input)) {
    if (task?.feedbackContextRequest) {
      if (route === 'delivery') return { ...request, eventId: task.feedbackContextRequest.eventId };
      if (
        route === 'continuation' &&
        input.action === 'delivery' &&
        request.delivery &&
        typeof request.delivery === 'object'
      )
        return {
          ...request,
          delivery: { ...request.delivery, eventId: task.feedbackContextRequest.eventId },
        };
    }
    return request;
  }
  const admission = task?.admission;
  const event = nativeFeedbackSource(
    task?.record?.feedback?.events ?? [],
    task?.feedbackContextRequest?.eventId,
    admission && `${admission.repository.owner.login}/${admission.repository.name}`,
    input.source,
  );
  const authored = { ...request };
  delete authored.source;
  return { ...authored, eventId: event.id };
}
