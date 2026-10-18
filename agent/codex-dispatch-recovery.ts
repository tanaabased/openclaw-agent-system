import { automationHash } from './automation-hash.ts';
import type { codexDispatchNative } from './codex-dispatch-native.ts';
import type { DispatchState, DispatchRecord } from './codex-dispatch-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';

type Native = ReturnType<typeof codexDispatchNative>;

export default async function recoverDispatch(
  input: Record<string, unknown>,
  context: {
    action: 'retire' | 'reset' | 'retry-denied';
    state: DispatchState;
    record: DispatchRecord;
    intake: IntakeRecord;
    sourceThreadId: string;
    manifestDigest: string;
    issueUrl: string;
    caller: string;
    now: number;
    save(): Promise<void>;
    fresh(): Promise<void>;
    revalidate(): Promise<unknown>;
    connect(): Promise<GitHubNotificationIntakeClient>;
    withNative<T>(operation: (host: Native) => Promise<T>): Promise<T>;
  },
) {
  const {
    action,
    state,
    record,
    intake,
    sourceThreadId,
    manifestDigest,
    issueUrl,
    caller,
    now,
    save,
    fresh,
    revalidate,
    connect,
    withNative,
  } = context;
  if (action === 'retire') {
    if (
      state.records.some(
        (entry) =>
          !entry.handoff && (entry.threadId === caller || entry.receiptThreadId === caller),
      )
    )
      throw new Error('dispatch-operator-caller-required');
    if (record.sourceThreadId !== sourceThreadId) throw new Error('dispatch-retire-unavailable');
    const client = await connect();
    const item = await client.getItem(
      intake.repository.owner.login,
      intake.repository.name,
      intake.issue.number,
    );
    if (
      !githubIdentityMatches(client.identity, intake.receiving) ||
      item.nodeId !== intake.issue.nodeId ||
      item.databaseId !== intake.issue.databaseId ||
      item.itemType !== 'issue' ||
      item.state !== 'closed'
    )
      throw new Error('dispatch-retire-closed-issue-required');
    const digest = automationHash({ record, manifest: manifestDigest });
    await fresh();
    if (input.digest === undefined)
      return {
        status: 'retire-available',
        id: record.id,
        digest,
        issue: issueUrl,
        threadId: record.threadId ?? record.receiptThreadId,
        instruction:
          'Retire this closed issue from the queue, preserving its evidence. This does not stop or archive a native chat or remove its worktree; clean those up through native controls. Only a new assignment event can admit it again.',
      };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    record.retired = { at: now, by: caller };
    await save();
    return { status: 'retired', id: record.id, retired: record.retired };
  }
  if (action === 'reset') {
    if (
      state.records.some((entry) => entry.threadId === caller || entry.receiptThreadId === caller)
    )
      throw new Error('dispatch-operator-caller-required');
    if (
      record.sourceThreadId !== sourceThreadId ||
      record.phase !== 'complete' ||
      !record.result ||
      !record.request ||
      !record.threadId
    )
      throw new Error('dispatch-reset-unavailable');
    const native = await withNative((client) =>
      client.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request!.prompt,
        createdAfter: record.createdAt,
        threadId: record.threadId,
      }),
    );
    if (
      !native ||
      !record.resultTurnId ||
      native.turnId !== record.resultTurnId ||
      !['idle', 'notLoaded'].includes(native.status) ||
      native.turnStatus !== 'completed'
    )
      throw new Error('dispatch-reset-chat-active');
    const digest = automationHash({ record, manifest: manifestDigest, turnId: native.turnId });
    await fresh();
    if (input.digest === undefined)
      return {
        status: 'reset-available',
        id: record.id,
        digest,
        issue: issueUrl,
        threadId: record.threadId,
        outcome: record.result.outcome,
        instruction:
          'Reset preserves this assessment and worktree. Only a new assignment event after reset permits one fresh assessment through normal intake. No implementation is authorized.',
      };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    record.reset = { at: now, by: caller };
    await save();
    return {
      status: 'reset',
      changed: true,
      id: record.id,
      threadId: record.threadId,
      awaiting: 'new-assignment',
      reset: record.reset,
    };
  }
  if (action === 'retry-denied') {
    if (
      record.sourceThreadId !== sourceThreadId ||
      !record.request ||
      !['creating', 'blocked', 'waiting', 'retrying'].includes(record.phase) ||
      record.clientThreadId ||
      record.receiptThreadId ||
      record.threadId ||
      record.worktree ||
      (record.deniedCreations?.length ?? 0) >= 8
    )
      throw new Error('dispatch-denial-unverified');
    await revalidate();
    const denial = await withNative(async (native) => {
      const evidence = await native.deniedCreation(
        record.sourceThreadId,
        record.request!,
        input.approvedCallId as string | undefined,
      );
      const found = await native.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request!.prompt,
        createdAfter: record.createdAt,
      });
      if (found) throw new Error('dispatch-denial-unverified');
      return evidence;
    });
    const digest = automationHash({
      record,
      manifest: manifestDigest,
      denial,
      approvedCallId: input.approvedCallId,
    });
    await fresh();
    if (input.digest === undefined)
      return { status: 'retry-available', id: record.id, digest, denial };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    record.deniedCreations = [
      ...(record.deniedCreations ?? []),
      {
        request: record.request,
        createdAt: record.createdAt,
        recoveredAt: now,
        ...denial,
        ...(input.approvedCallId ? { approvedBy: caller } : {}),
      },
    ];
    delete record.request;
    delete record.result;
    delete record.stageReceipt;
    delete record.notice;
    delete record.retryAfter;
    record.phase = 'routing';
    await save();
    return { status: 'retry-ready', changed: true, id: record.id };
  }
}
