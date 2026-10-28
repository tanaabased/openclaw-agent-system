import issueWorkflowMode from './issue-workflow-mode.ts';
import codexWorkContext from './codex-work-context.ts';
import recordCodexWorkResult from './codex-work-result.ts';
import advanceCodexWorkTurn from './codex-work-turn.ts';
import { dispatchAdmission } from './managed-issue.ts';
import { realpath } from 'node:fs/promises';

import { needsAutoDecision } from './auto-decision.ts';
import { automationHash } from './automation-hash.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
import { verifyDispatchWorktree } from './codex-dispatch-project.ts';
import type { DispatchRecord, DispatchState } from './codex-dispatch-state.ts';
import codexHostAccess from './codex-host-access.ts';
import { selectCodexIntake } from './codex-intake.ts';
import codexSessionSettings from './codex-session-settings.ts';
import { dispatchFailurePhase, dispatchRetryDue, scheduleDispatchRetry } from './dispatch-retry.ts';
import { feedbackWorkStarted } from './feedback-work.ts';
import issueProgression, { retainedIssueProgression } from './issue-progression.ts';
import issueWorkflowProgress from './issue-workflow-progress.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { notificationAuthorityDigest } from './notification-authority.ts';
import workflowFailure from './workflow-failure.ts';
import { selectWorkflowStage } from './workflow-stage.ts';

export async function prepareCodexWork(state: DispatchState, context: CodexWorkContext) {
  const { input, deps, current, caller, native, admissions, save } = context;
  if (input.action === 'next' || input.action === 'context')
    for (const record of state.records) {
      const liveMode = issueWorkflowMode(current.manifest.github?.notifications, record);
      if (input.action === 'context' && record.id !== input.id) continue;
      if (input.action === 'context' && caller !== record.threadId)
        throw new Error('continuation-issue-caller-required');
      const admitted = dispatchAdmission(record, admissions?.records ?? []);
      if (
        record.continuation ||
        (!context.operatorInput && needsAutoDecision(record, liveMode)) ||
        (record.autoDecision && !record.autoDecision.ended && input.action !== 'context') ||
        feedbackWorkStarted(record) ||
        record.result?.outcome !== 'plan-ready' ||
        !record.project ||
        !record.worktree ||
        !record.request ||
        record.handoff ||
        record.supersededBy ||
        record.retired ||
        record.retirement ||
        record.reset ||
        !admitted ||
        liveWorkflowPolicy(
          current.manifest,
          'codex',
          admitted,
          context.operatorInput ? 'continued-work' : 'implementation',
        )
      )
        continue;
      if (record.retry && (record.retryAfter ?? 0) > (deps.now ?? Date.now)()) continue;
      try {
        const selected = await selectWorkflowStage({
          stage: 'implementation',
          configuration: {
            ...current.manifest.github?.notifications?.issueAssignment?.implementation,
            ...record.manualIssue?.selections?.implementation,
          },
          workspace: current.workspace,
          observedAt: (deps.now ?? Date.now)(),
          resolveSkill: (id) => native.assessmentSkill(record.worktree!, id),
        });
        (context.preparedSelections ??= new Set()).add(record.id);
        record.continuation = {
          phase: 'waiting',
          selection: selected.selection,
          policyDigest: notificationAuthorityDigest(current.manifest.github?.notifications),
        };
        delete record.retry;
        delete record.retryAfter;
      } catch (error) {
        if (codexHostAccess(error)) throw error;
        const code = workflowFailure(error, 'continuation-selection-unavailable').code;
        if (!scheduleDispatchRetry(record, code, error, (deps.now ?? Date.now)())) {
          record.retry = { code, attempts: 1 };
          record.retryAfter = (deps.now ?? Date.now)() + 300000;
        }
      }
      await save();
    }
}
export default async function advanceCodexWork(record: DispatchRecord, context: CodexWorkContext) {
  const {
    pluginData,
    input,
    deps,
    current,
    caller,
    activation,
    native,
    git,
    occurrence,
    admissions,
    save,
    signal,
  } = context;
  const liveMode = issueWorkflowMode(current.manifest.github?.notifications, record);
  const retryDenied = input.action === 'retry-denied';
  const retry = input.action === 'retry' || retryDenied;
  try {
    const work = record.continuation;
    if (
      work?.phase === 'blocked' &&
      ['continuation-auto-wait', 'continuation-assessment-not-actionable'].includes(
        work.code ?? '',
      ) &&
      !retainedIssueProgression(record)
    ) {
      work.phase = 'waiting';
      delete work.code;
      delete work.retryAfter;
    }
    if (work?.phase === 'blocked' && work.code === 'continuation-turn-ended' && !retry) {
      work.phase =
        work.result?.outcome === 'done'
          ? 'delivery'
          : work.result?.outcome === 'clarification-needed' || work.result?.outcome === 'blocked'
            ? work.result.outcome
            : 'running';
      delete work.code;
      delete work.retryAfter;
    }
    if (
      !work ||
      !record.threadId ||
      !record.worktree ||
      !record.project ||
      !record.request ||
      record.handoff ||
      record.supersededBy ||
      record.retired ||
      record.retirement ||
      record.feedbackReactivation ||
      record.reset
    )
      throw new Error('continuation-managed-issue-required');
    if (
      input.action === 'next' &&
      ((work.retry && !dispatchRetryDue(work, (deps.now ?? Date.now)())) ||
        (work.code && (work.retryAfter ?? 0) > (deps.now ?? Date.now)()))
    )
      return undefined;
    if (!occurrence && !retry && caller !== record.threadId)
      throw new Error('continuation-issue-caller-required');
    if (
      retry &&
      (!(
        (work.phase === 'blocked' &&
          (retryDenied
            ? ['continuation-native-send-failed']
            : ['continuation-turn-ended', 'continuation-send-mismatch']
          ).includes(work.code ?? '')) ||
        (work.phase === 'prepared' && !work.binding)
      ) ||
        !work.attempt ||
        work.result ||
        work.publicationAttempt ||
        record.delivery)
    )
      throw new Error('continuation-retry-unavailable');
    const resumeBlocked =
      input.action === 'context' &&
      work.phase === 'blocked' &&
      work.result?.outcome === 'blocked' &&
      !work.code;
    const blockedTurnId =
      work.blockedTurnId ?? work.activeTurnId ?? work.binding?.turnId ?? work.attempt?.turnId;
    const progress = issueWorkflowProgress(record);
    if (!retry && !resumeBlocked && ['stopped', 'complete'].includes(progress.action)) {
      if (input.action === 'next') return undefined;
      if (progress.action === 'stopped' || !work.result)
        return { status: progress.status, id: record.id, code: work.code };
    }
    if (!record.result) return undefined;
    const admitted = dispatchAdmission(record, admissions?.records ?? []);
    if (!admitted) throw new Error('continuation-admission-missing');
    const enteringImplementation = !retainedIssueProgression(record);
    const authorizeLive = async () => {
      const live = await selectCodexIntake(pluginData, deps);
      const held = liveWorkflowPolicy(
        live.manifest,
        'codex',
        admitted,
        enteringImplementation && !context.operatorInput ? 'implementation' : 'continued-work',
      );
      if (held) throw new WorkflowPolicyHeld(held);
      if (
        enteringImplementation &&
        issueWorkflowMode(live.manifest.github?.notifications, record) !== liveMode
      )
        throw new WorkflowPolicyHeld('workflow-mode-updated');
      return live;
    };
    if (!['reconcile', 'cancel', 'result'].includes(input.action)) await authorizeLive();
    if (
      !work.attempt &&
      !work.binding &&
      (input.action === 'next' ||
        (context.operatorInput &&
          input.action === 'context' &&
          !context.preparedSelections?.has(record.id)))
    ) {
      const live = await authorizeLive();
      const selected = await selectWorkflowStage({
        stage: 'implementation',
        configuration: {
          ...live.manifest.github?.notifications?.issueAssignment?.implementation,
          ...record.manualIssue?.selections?.implementation,
        },
        workspace: current.workspace,
        observedAt: work.selection.observedAt,
        resolveSkill: (id) => native.assessmentSkill(record.worktree!, id),
      });
      work.selection = selected.selection;
    }
    delete work.policyHeld;
    if (enteringImplementation && liveMode === 'auto' && !context.operatorInput) {
      if (!record.result.decision) throw new WorkflowPolicyHeld('auto-decision-required');
      if (
        !record.stageReceipt ||
        record.stageReceipt.resultDigest !== automationHash(record.result) ||
        record.stageReceipt.binding.selectionDigest !== automationHash(record.assessment) ||
        record.stageReceipt.binding.dispatchDigest !== automationHash(record.request) ||
        record.stageReceipt.binding.evidenceDigest !==
          automationHash(JSON.parse(record.context!)) ||
        record.stageReceipt.binding.turnId !== record.resultTurnId ||
        record.stageReceipt.binding.threadId !== record.threadId ||
        record.stageReceipt.binding.worktree !== record.worktree
      )
        throw new Error('continuation-assessment-changed');
      if (
        !record.assessment ||
        (work.assessmentSelectionDigest &&
          work.assessmentSelectionDigest !== automationHash(record.assessment))
      )
        throw new Error('continuation-assessment-selection-changed');
    }
    const transition = issueProgression(record, {
      mode: liveMode ?? 'auto',
      now: (deps.now ?? Date.now)(),
      operator: Boolean(context.operatorInput),
    });
    if (!['reconcile', 'cancel', 'result'].includes(input.action) && transition.status !== 'ready')
      throw new WorkflowPolicyHeld(transition.reason);
    if (work.assessmentDigest && work.assessmentDigest !== automationHash(record.result))
      throw new Error('continuation-assessment-changed');
    const { client, repo } = await revalidateDispatchAssignment(
      current,
      admitted,
      deps,
      signal,
      true,
      record,
    );
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
    await verifyDispatchWorktree(
      record.project,
      found.cwd,
      admitted.repository.owner.login + '/' + admitted.repository.name,
      git,
      work.attempt ? 'handoff' : undefined,
    );
    record.effective = codexSessionSettings(record, found);
    await save();
    if (input.action === 'cancel') {
      work.phase = 'cancelled';
      await save();
      return { status: 'cancelled' as const, id: record.id };
    }
    let selection = work.selection;
    if (input.action === 'context' && work.result?.outcome !== 'done' && !context.operatorInput) {
      const currentSelection = await selectWorkflowStage({
        stage: 'implementation',
        configuration: {
          ...current.manifest.github?.notifications?.issueAssignment?.implementation,
          ...record.manualIssue?.selections?.implementation,
        },
        workspace: current.workspace,
        observedAt: (deps.now ?? Date.now)(),
        resolveSkill: (id) => native.assessmentSkill(found.cwd, id),
      });
      selection = currentSelection.selection;
    }
    // recheck the saved native activation after provider and skill reads, before side effects.
    const fresh = record.manualIssue
      ? { sourceThreadId: record.sourceThreadId }
      : await (deps.activation ?? inspectCodexDispatchActivation)(
          pluginData,
          { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
          false,
          true,
          input.action === 'delivery' ? 'publication' : 'implementation',
        );
    if (fresh.sourceThreadId !== activation.sourceThreadId)
      throw new Error('continuation-schedule-binding-mismatch');
    if (input.action !== 'reconcile' && input.action !== 'result') await authorizeLive();
    const turn = await advanceCodexWorkTurn(record, context, {
      admitted,
      found: { ...found, turnId: found.turnId },
      transition,
      liveMode,
      authorizeLive,
      resumeBlocked,
      blockedTurnId,
      selection,
    });
    if (!turn.ready) return turn.response;
    const { activeAttempt, receipt, currentTurnEnded } = turn;
    if (input.action === 'context')
      return await codexWorkContext(record, context, {
        client,
        repo,
        admitted,
        selection: turn.selection,
      });
    if (input.action === 'result')
      return await recordCodexWorkResult(
        record,
        context,
        { ...found, turnId: found.turnId },
        turn.revisionInput,
      );
    if (input.action === 'delivery') {
      if (work.scope === 'local') throw new Error('implementation-publication-not-authorized');
      if (
        work.result?.outcome !== 'done' ||
        !work.head ||
        (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim() !== work.head
      )
        throw new Error('continuation-implementation-required');
      return { status: 'deliver' as const, id: record.id };
    }
    if (
      input.action === 'next' &&
      occurrence &&
      currentTurnEnded &&
      ['idle', 'notLoaded'].includes(found.status) &&
      ['implementation', 'delivery'].includes(issueWorkflowProgress(record).action)
    ) {
      work.retries = [
        ...(work.retries ?? []),
        {
          attempt: { ...activeAttempt, turnId: receipt.turnId },
          ...(work.binding ? { binding: work.binding } : {}),
          at: (deps.now ?? Date.now)(),
          by: caller,
        },
      ];
      const resume = {
        id: automationHash({ previous: activeAttempt.id, resume: work.retries.length }),
        sourceThreadId: activation.sourceThreadId,
        sourceTurnId: occurrence.id,
        beforeTurnId: found.turnId,
        request: {
          ...activeAttempt.request,
          prompt:
            (issueWorkflowProgress(record).action === 'delivery'
              ? 'Resume only the managed PR delivery. Reconcile the existing operation; never repeat implementation or create a replacement PR. '
              : 'Resume unfinished implementation in this issue. Reconcile current files, commits and the latest conversation; preserve completed work. ') +
            'Work remains authorized. Refresh continuationRuntime context with JSON on stdin: ' +
            JSON.stringify({ action: 'context', id: record.id }) +
            '. Honor current user direction, cancellation and native denial. Retain the result before finishing.',
        },
      };
      if (issueWorkflowProgress(record).action === 'delivery') work.publicationAttempt = resume;
      else {
        work.attempt = resume;
        work.phase = 'prepared';
      }
      delete work.binding;
      delete work.activeTurnId;
      delete work.code;
      await save();
      return { status: 'prepared' as const, id: record.id, request: resume.request };
    }
  } catch (error) {
    if (error instanceof WorkflowPolicyHeld && record.continuation) {
      record.continuation.policyHeld = error.reason;
      await save();
      if (input.action === 'next') return undefined;
      return { status: 'policy-held' as const, id: record.id, reason: error.reason };
    }
    if (codexHostAccess(error) || (input.action !== 'next' && input.action !== 'reconcile'))
      throw error;
    if (record.continuation) {
      record.continuation.code = workflowFailure(error, 'continuation-operation-failed').code;
      record.continuation.retryAfter = (deps.now ?? Date.now)() + 300000;
      scheduleDispatchRetry(
        record.continuation,
        record.continuation.code,
        error,
        (deps.now ?? Date.now)(),
      );
      if (dispatchFailurePhase(record.continuation, record.continuation.code, error) === 'blocked')
        record.continuation.phase = 'blocked';
      await save();
    }
    return {
      status: record.continuation
        ? dispatchFailurePhase(record.continuation, record.continuation.code!, error)
        : 'waiting',
      id: record.id,
      ...workflowFailure(error, 'continuation-operation-failed'),
      nextAction: 'next',
    };
  }
}
