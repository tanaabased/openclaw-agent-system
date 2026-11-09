import { dispatchAdmission } from './managed-issue.ts';
import resolveGitProtocol from '../tools/git/protocol.ts';
import codexContinuationNative from './codex-continuation-native.ts';
import { codexDispatchNative, type DispatchNativeThread } from './codex-dispatch-native.ts';
import CodexDispatchStore, { type DispatchRecord } from './codex-dispatch-state.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { retainedIssueProgression } from './issue-progression.ts';
import taskPullRequest from './task-pull-request.ts';

type Turn = { threadId: string; turnId?: string };
type Lookup = {
  find: ReturnType<typeof codexDispatchNative>['find'];
  receipt: ReturnType<typeof codexContinuationNative>;
};

/** resolve hints through native creation and send receipts, never provider text. */
export async function selectCodexTurnTask(
  records: readonly DispatchRecord[],
  turn: Turn,
  lookup: Lookup,
) {
  const owners = records.filter(
    (record) =>
      record.threadId === turn.threadId && !record.retired && !record.reset && !record.supersededBy,
  );
  if (owners.length > 1) throw new Error('turn-context-owner-ambiguous');
  const matches: { record: DispatchRecord; native: DispatchNativeThread }[] = [];
  for (const record of records) {
    if (
      !record.request ||
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
    if (!native || native.id !== turn.threadId) continue;
    matches.push({ record, native });
  }
  if (matches.length > 1) throw new Error('turn-context-owner-ambiguous');
  if (!matches.length) {
    if (owners.length) throw new Error('turn-context-owner-unverified');
    return;
  }
  const { record, native } = matches[0]!;
  const turnId = turn.turnId ?? native.turnId;
  if (!turnId) throw new Error('turn-context-native-turn-unavailable');
  const feedback = [];
  let unresolvedFeedback = false;
  for (const event of record.feedback?.events ?? []) {
    if (
      !event.attempt ||
      event.attempt.request.threadId !== turn.threadId ||
      (event.attempt.turnId && event.attempt.turnId !== turnId)
    )
      continue;
    const receipt = await lookup.receipt(record.sourceThreadId, event.attempt);
    if (receipt.status === 'verified' && receipt.turnId === turnId) {
      feedback.push(event);
    } else if (receipt.status !== 'verified') unresolvedFeedback = true;
  }
  const source = !unresolvedFeedback && feedback.length === 1 ? feedback[0] : undefined;
  const implementation = Boolean(retainedIssueProgression(record));
  return {
    currentTurn: { threadId: turn.threadId, turnId },
    receipt: record.id,
    stage:
      feedback.length || unresolvedFeedback
        ? 'feedback'
        : implementation
          ? 'implementation'
          : 'assessment',
    contextRequest: !feedback.length && !unresolvedFeedback ? { action: 'context' } : undefined,
    contextRuntime: implementation ? 'continuationRuntime' : 'dispatchRuntime',
    feedbackContextRequest: source && { action: 'context', id: record.id, eventId: source.id },
    worktree: record.worktree ?? native.cwd,
    nativeCwd: native.cwd,
    pullRequest: taskPullRequest(record),
    branch: record.issueBranch?.name,
  };
}

/** read the bound journal and native receipts without discovery, reconciliation, or writes. */
export async function readCodexTaskOwner(pluginData: string, turn: Turn) {
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
    const selected = await selectCodexTurnTask(records, turn, {
      find: codexDispatchNative(connection.request).find,
      receipt: codexContinuationNative(connection.request),
    });
    const record = selected && records.find((record) => record.id === selected.receipt);
    return (
      selected &&
      record && {
        ...selected,
        record,
        admission: dispatchAdmission(record, (await current.store.read())?.records ?? []),
        git: { protocol: resolveGitProtocol(current.manifest) },
      }
    );
  } finally {
    await connection.close();
  }
}

/** expose lookup hints without making native ownership an input to subsequent tools. */
export default async function readCodexTurnTask(pluginData: string, turn: Turn) {
  const owner = await readCodexTaskOwner(pluginData, turn);
  if (!owner) return;
  const { record: _record, admission: _admission, ...facts } = owner;
  return {
    ...facts,
    feedbackContextRequest: facts.feedbackContextRequest && { action: 'context' },
  };
}
