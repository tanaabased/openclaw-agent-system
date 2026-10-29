import issueWorkflowMode from './issue-workflow-mode.ts';
import { dispatchAdmission } from './managed-issue.ts';
import { realpath } from 'node:fs/promises';

import { autoDecisionInstructions, needsAutoDecision } from './auto-decision.ts';
import { automationHash } from './automation-hash.ts';
import codexCapacity, { codexItemOccupied } from './codex-capacity.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
import { verifyDispatchWorktree } from './codex-dispatch-project.ts';
import type { DispatchState } from './codex-dispatch-state.ts';
import codexHostAccess from './codex-host-access.ts';
import { selectCodexIntake } from './codex-intake.ts';
import codexSessionSettings from './codex-session-settings.ts';
import { dispatchRetryDue, scheduleDispatchRetry } from './dispatch-retry.ts';
import workflowFailure from './workflow-failure.ts';

export default async function advanceCodexAutoDecision(
  state: DispatchState,
  context: CodexWorkContext,
) {
  const {
    pluginData,
    input,
    deps,
    current,
    activation,
    native,
    continuationNative,
    git,
    occurrence,
    admissions,
    save,
    signal,
  } = context;
  let decisionPending: { status: 'pending' | 'blocked'; id: string; code?: string } | undefined;
  if (occurrence) {
    for (const record of state.records) {
      const liveMode = issueWorkflowMode(current.manifest.github?.notifications, record);
      if (input.id && input.id !== record.id) continue;
      const pending = record.autoDecision && !record.autoDecision.ended;
      if (!pending && !needsAutoDecision(record, liveMode)) continue;
      if (
        record.continuation?.phase === 'cancelled' ||
        record.handoff ||
        record.retired ||
        record.retirement ||
        record.reset
      )
        continue;
      const admitted = dispatchAdmission(record, admissions?.records ?? []);
      if (!admitted || !record.request || !record.project || !record.threadId || !record.worktree)
        continue;
      if (
        !pending &&
        (input.action !== 'next' ||
          (!codexItemOccupied(record) &&
            !codexCapacity(state.records, current.policy?.policy.maxConcurrentItems ?? 1)
              .available))
      )
        continue;
      if (
        input.action === 'next' &&
        record.retry &&
        !dispatchRetryDue(record, (deps.now ?? Date.now)())
      )
        continue;
      try {
        await revalidateDispatchAssignment(current, admitted, deps, signal, true, record);
        if (record.autoDecision && !record.autoDecision.ended) {
          const decision = record.autoDecision;
          if (decision.code) {
            if (input.action === 'next') continue;
            return { response: { status: 'blocked' as const, id: record.id, code: decision.code } };
          }
          const receipt = await continuationNative(record.sourceThreadId, decision.attempt);
          if (receipt.status === 'blocked' || receipt.status === 'mismatch') {
            decision.code = receipt.code;
            await save();
            decisionPending = { status: 'blocked' as const, id: record.id, code: decision.code };
            continue;
          }
          if (receipt.status !== 'verified') {
            decisionPending = {
              status: 'pending' as const,
              id: record.id,
              code: 'continuation-send-unverified',
            };
            continue;
          }
          if (decision.attempt.turnId && decision.attempt.turnId !== receipt.turnId)
            throw new Error('continuation-turn-changed');
          decision.attempt.turnId = receipt.turnId;
          if (receipt.ended) decision.ended = true;
          await save();
          if (!decision.ended) {
            decisionPending = { status: 'pending' as const, id: record.id };
            continue;
          }
          if (!needsAutoDecision(record, liveMode)) continue;
        }
        const found = await native.find({
          sourceThreadId: record.sourceThreadId,
          prompt: record.request.prompt,
          createdAfter: record.createdAt,
          threadId: record.threadId,
        });
        if (
          !found ||
          !found.turnId ||
          found.id !== record.threadId ||
          (await realpath(found.cwd)) !== (await realpath(record.worktree))
        )
          throw new Error('continuation-native-binding-mismatch');
        if (found.turnStatus !== 'completed' || !['idle', 'notLoaded'].includes(found.status))
          continue;
        await verifyDispatchWorktree(
          record.project,
          found.cwd,
          admitted.repository.owner.login + '/' + admitted.repository.name,
          git,
        );
        record.effective = codexSessionSettings(record, found);
        await save();
        const live = await selectCodexIntake(pluginData, deps);
        if (
          !needsAutoDecision(record, issueWorkflowMode(live.manifest.github?.notifications, record))
        )
          continue;
        record.autoDecision = {
          previousAttempts: record.autoDecision
            ? [...(record.autoDecision.previousAttempts ?? []), record.autoDecision.attempt]
            : [],
          attempt: {
            id: automationHash({
              id: record.id,
              decision: automationHash(record.result),
              before: found.turnId,
            }),
            sourceThreadId: activation.sourceThreadId,
            sourceTurnId: occurrence.id,
            beforeTurnId: found.turnId,
            request: {
              threadId: record.threadId,
              prompt:
                autoDecisionInstructions +
                ' Refresh dispatchRuntime assessment context with JSON on stdin: ' +
                JSON.stringify({ action: 'context', id: record.id }) +
                '.',
            },
          },
        };
        delete record.nativeInactive;
        delete record.capacityObservation;
        await save();
        return {
          response: {
            status: 'prepared' as const,
            id: record.id,
            request: record.autoDecision.attempt.request,
          },
        };
      } catch (error) {
        if (codexHostAccess(error)) throw error;
        const failure = workflowFailure(error, 'auto-decision-pending');
        scheduleDispatchRetry(record, failure.code, error, (deps.now ?? Date.now)());
        await save();
        decisionPending = { status: 'pending' as const, id: record.id, ...failure };
        continue;
      }
    }
  }
  return { decisionPending };
}
