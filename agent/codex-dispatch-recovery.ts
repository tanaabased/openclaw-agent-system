import {
  cleanupConfigurationDiagnostic,
  type CleanupConfiguration,
} from './cleanup-configuration.ts';
import { automationHash } from './automation-hash.ts';
import assignmentRetirement from './assignment-retirement.ts';
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
    readConfiguration(): Promise<CleanupConfiguration>;
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
    const configuration = await context.readConfiguration();
    if (configuration.status === 'blocked')
      return {
        status: 'retirement-pending',
        id: record.id,
        code: configuration.code,
        diagnostic: cleanupConfigurationDiagnostic(configuration),
      };
    const digest = automationHash({
      record,
      manifest: manifestDigest,
      configuration: configuration.digest,
    });
    await fresh();
    if (input.digest === undefined)
      return {
        status: 'retire-available',
        id: record.id,
        digest,
        issue: issueUrl,
        threadId: record.threadId ?? record.receiptThreadId,
        instruction:
          'Queue this closed issue for retirement, preserving its evidence and any existing grace deadline. The owning intake performs configured cleanup after verifying native inactivity and preservation. A paused intake must resume before cleanup can proceed.',
      };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    const verifiedConfiguration = await context.readConfiguration();
    if (
      verifiedConfiguration.status !== 'ready' ||
      verifiedConfiguration.digest !== configuration.digest
    )
      throw new Error('retirement-configuration-changed');
    record.reservationVersion = 1;
    record.retirement = assignmentRetirement({
      previous: record.retirement,
      reason: 'issue-closed',
      intakeId: record.intakeId,
      now,
      graceMinutes: configuration.graceMinutes,
    });
    await save();
    return { status: 'retirement-pending', id: record.id, retirement: record.retirement };
  }
  if (action === 'reset') {
    if (
      state.records.some((entry) => entry.threadId === caller || entry.receiptThreadId === caller)
    )
      throw new Error('dispatch-operator-caller-required');
    if (record.phase !== 'complete' || !record.result || !record.request || !record.threadId)
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
      record.continuation?.attempt ||
      record.continuation?.publicationAttempt
    )
      throw new Error('dispatch-denial-unverified');
    await revalidate();
    const denial = await withNative(async (native) => {
      const evidence = await native.deniedCreation(
        record.sourceThreadId,
        record.request!,
        { createdAt: record.createdAt, turnId: record.preparationTurnId },
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
        ...(record.continuation ? { continuation: record.continuation } : {}),
        ...denial,
        ...(input.approvedCallId ? { approvedBy: caller } : {}),
      },
    ];
    delete record.continuation;
    delete record.preparationTurnId;
    delete record.request;
    delete record.result;
    delete record.stageReceipt;
    delete record.retryAfter;
    record.phase = 'routing';
    await save();
    return { status: 'retry-ready', changed: true, id: record.id };
  }
}
