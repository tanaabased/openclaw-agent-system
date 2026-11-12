import {
  codexDispatchNative,
  type DispatchNativeThread,
} from './tasks/dispatch/codex-dispatch-native.ts';
import type { DispatchRecord } from './tasks/dispatch/codex-dispatch-state.ts';
import { type CodexThreadRequest } from './codex-thread-client.ts';

/** reset observes compact terminal identities without recreating runnable creation requests. */
export default async function observeResetThread(
  request: CodexThreadRequest,
  entry: DispatchRecord,
): Promise<DispatchNativeThread | undefined> {
  if (entry.request)
    return codexDispatchNative(request).find({
      sourceThreadId: entry.sourceThreadId,
      prompt: entry.request.prompt,
      createdAfter: entry.createdAt,
      threadId: entry.threadId,
      observationOnly: true,
    });
  if (entry.threadId) throw new Error('notification-reset-native-identity-unresolved');
  return undefined;
}
