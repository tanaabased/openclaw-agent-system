import { realpath } from 'node:fs/promises';

import codexContinuationNative from './codex-continuation-native.ts';
import { codexDispatchNative, type DispatchNativeThread } from './codex-dispatch-native.ts';
import CodexDispatchStore, { type DispatchRecord } from './codex-dispatch-state.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { retainedIssueProgression } from './issue-progression.ts';
import taskPullRequest from './task-pull-request.ts';

type Turn = { threadId: string; turnId: string };
type Lookup = {
  find: ReturnType<typeof codexDispatchNative>['find'];
  receipt: ReturnType<typeof codexContinuationNative>;
  path: typeof realpath;
};

/** resolve hints through native creation and send receipts, never provider text. */
export async function selectCodexTurnTask(
  records: readonly DispatchRecord[],
  turn: Turn,
  lookup: Lookup,
) {
  const matches: { record: DispatchRecord; native: DispatchNativeThread }[] = [];
  for (const record of records) {
    if (
      !record.request ||
      !record.worktree ||
      record.retired ||
      record.reset ||
      record.supersededBy ||
      (record.threadId ? record.threadId !== turn.threadId : record.phase !== 'creating')
    )
      continue;
    let native;
    try {
      native = await lookup.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request.prompt,
        createdAfter: record.createdAt,
        threadId: turn.threadId,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'dispatch-native-readback-diverged') continue;
      throw error;
    }
    if (
      !native ||
      native.id !== turn.threadId ||
      (await lookup.path(native.cwd)) !== (await lookup.path(record.worktree))
    )
      continue;
    matches.push({ record, native });
  }
  if (matches.length !== 1) return;
  const { record } = matches[0]!;
  const feedback = [];
  let unresolvedFeedback = false;
  for (const event of record.feedback?.events ?? []) {
    if (
      !event.attempt ||
      event.attempt.request.threadId !== turn.threadId ||
      (event.attempt.turnId && event.attempt.turnId !== turn.turnId)
    )
      continue;
    const receipt = await lookup.receipt(record.sourceThreadId, event.attempt);
    if (receipt.status === 'verified' && receipt.turnId === turn.turnId) {
      if (!event.native) return;
      feedback.push(event);
    } else if (receipt.status !== 'verified') unresolvedFeedback = true;
  }
  const source = !unresolvedFeedback && feedback.length === 1 ? feedback[0] : undefined;
  const implementation = Boolean(retainedIssueProgression(record));
  return {
    receipt: record.id,
    stage:
      feedback.length || unresolvedFeedback
        ? 'feedback'
        : implementation
          ? 'implementation'
          : 'assessment',
    contextRequest:
      !feedback.length && !unresolvedFeedback ? { action: 'context', id: record.id } : undefined,
    contextRuntime: implementation ? 'continuationRuntime' : 'dispatchRuntime',
    feedbackContextRequest: source && { action: 'context', id: record.id, eventId: source.id },
    worktree: record.worktree,
    pullRequest: taskPullRequest(record),
    branch: record.issueBranch?.name,
  };
}

/** read the bound journal and native receipts without discovery, reconciliation, or writes. */
export default async function readCodexTurnTask(pluginData: string, turn: Turn) {
  const current = await selectCodexIntake(
    pluginData,
    {},
    { resolvePolicy: false, inspectionOnly: true },
  );
  const journal = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const records = (await journal.read()).records;
  if (
    !records.some(
      (record) =>
        record.threadId === turn.threadId || (!record.threadId && record.phase === 'creating'),
    )
  )
    return;
  const connection = await connectCodexThreads(current.workspace, current.codexHome);
  try {
    return await selectCodexTurnTask(records, turn, {
      find: codexDispatchNative(connection.request).find,
      receipt: codexContinuationNative(connection.request),
      path: realpath,
    });
  } finally {
    await connection.close();
  }
}
