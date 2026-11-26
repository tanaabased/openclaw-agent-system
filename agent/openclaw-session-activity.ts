import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { OpenClawDispatchRecord } from './tasks/dispatch/openclaw-dispatch-state.ts';
import liveQueueCount from './openclaw-live-queue.ts';
import { describeIssueSession, sessionObject } from './openclaw-session-create.ts';

/** native activity includes operator work; queued feedback never creates another session. */
export default async function observeIssueActivity(
  request: DispatchRequest,
  record: OpenClawDispatchRecord,
  config: OpenClawConfig,
) {
  const sessionId = await describeIssueSession(request, record, config, 'feedback');
  const history = sessionObject(
    await request('chat.history', { sessionKey: record.threadId, limit: 1 }),
  );
  const info = sessionObject(history.sessionInfo);
  const queued = liveQueueCount(sessionObject(history.pendingInputs));
  if (
    history.sessionId !== sessionId ||
    typeof info.hasActiveRun !== 'boolean' ||
    queued === undefined
  )
    throw new Error('feedback-session-unverified');
  return {
    busy: info.hasActiveRun || queued > 0,
    leaf: info.activeLeafEntryId,
  };
}
