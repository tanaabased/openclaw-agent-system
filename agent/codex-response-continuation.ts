import { dispatchAdmission } from './managed-issue.ts';
import { realpath } from 'node:fs/promises';

import { automationHash } from './automation-hash.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
import { verifyDispatchWorktree } from './codex-dispatch-project.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import codexSessionSettings from './codex-session-settings.ts';
import pendingPublicResponse from './pending-public-response.ts';
import { requireWorkflowSchedule } from './workflow-result.ts';

/** prepare one native response-only continuation; native receipts own send recovery. */
export default async function continueCodexResponse(
  record: DispatchRecord,
  context: CodexWorkContext,
) {
  const pending = pendingPublicResponse(record);
  const { occurrence, native, continuationNative, current, deps, signal, save } = context;
  if (
    (!pending && (!record.summaryRecovery || record.summaryRecovery.ended)) ||
    pending?.state === 'blocked' ||
    record.summaryRecovery?.code ||
    !occurrence ||
    !record.request ||
    !record.project ||
    !record.threadId ||
    !record.worktree ||
    !record.resultTurnId
  )
    return;
  // normal implementation/delivery turns can finish their own pending response without another send.
  if (record.continuation && record.continuation.phase !== 'complete') return;
  if (context.schedule)
    requireWorkflowSchedule(context.schedule.saved, context.schedule.current, 'assessment-summary');
  const intake = dispatchAdmission(record, context.admissions?.records ?? []);
  if (!intake) return;
  await revalidateDispatchAssignment(current, intake, deps, signal, true, record);
  const found = await native.find({
    sourceThreadId: record.sourceThreadId,
    prompt: record.request.prompt,
    createdAfter: record.createdAt,
    threadId: record.threadId,
  });
  if (
    !found?.turnId ||
    found.id !== record.threadId ||
    (await realpath(found.cwd)) !== (await realpath(record.worktree))
  )
    throw new Error('assessment-summary-binding-mismatch');
  await verifyDispatchWorktree(
    record.project,
    found.cwd,
    `${intake.repository.owner.login}/${intake.repository.name}`,
    context.git,
    'handoff',
  );
  record.effective = codexSessionSettings(record, found);
  await save();
  const recovery = record.summaryRecovery;
  if (recovery) {
    const receipt = await continuationNative(record.sourceThreadId, recovery.attempt);
    if (receipt.status === 'blocked' || receipt.status === 'mismatch') {
      recovery.code = receipt.code;
      await save();
      return { status: 'blocked' as const, id: record.id, code: receipt.code };
    }
    if (receipt.status === 'uncertain') return { status: 'pending' as const, id: record.id };
    recovery.attempt.turnId = receipt.turnId;
    await save();
    if (!receipt.ended) return { status: 'pending' as const, id: record.id };
    recovery.ended = true;
    await save();
    if (!pending || recovery.revision === pending.revision) return;
  }
  if (!pending) return;
  if (!['idle', 'notLoaded'].includes(found.status) || !found.turnEnded) return;
  const source = await continuationNative(record.threadId, {
    origin: 'assessment',
    id: automationHash({ id: record.id, source: record.resultTurnId }),
    sourceThreadId: record.threadId,
    sourceTurnId: record.resultTurnId,
    beforeTurnId: record.resultTurnId,
    turnId: record.resultTurnId,
    request: {
      threadId: record.threadId,
      prompt: record.request.prompt,
    },
  });
  if (source.status !== 'verified' || !source.ended) {
    if (source.status === 'blocked')
      return { status: 'blocked' as const, id: record.id, code: source.code };
    return;
  }
  const attempt = {
    id: automationHash({ id: record.id, summary: pending.revision }),
    sourceThreadId: context.caller,
    sourceTurnId: occurrence.id,
    beforeTurnId: found.turnId,
    request: {
      threadId: record.threadId,
      prompt: `Recover only the pending public assessment summary in this existing issue chat. The complete private assessment is saved. Call dispatchRuntime action summary with id ${record.id} and operation ${pending.summary?.attempt ? 'reconcile' : 'compose'} using the trusted runtime from this chat. Follow verified instructions, retain the complete private presentation and show the public outcome. Do not repeat assessment or implementation, change stages, or repost an uncertain write. Preserve current user direction and native denial.`,
    },
  };
  if (record.summaryRecovery)
    (record.previousSummaryAttempts ??= []).push(record.summaryRecovery.attempt);
  delete record.nativeInactive;
  record.summaryRecovery = { revision: pending.revision, attempt };
  await save();
  return { status: 'prepared' as const, id: record.id, request: attempt.request };
}
