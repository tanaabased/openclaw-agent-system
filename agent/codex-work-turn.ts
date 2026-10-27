import type { AssessmentSelection } from './assessment-selection.ts';
import implementationRevision from './implementation-revision.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import { automationHash } from './automation-hash.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import type { DispatchNativeThread } from './codex-dispatch-native.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import { verifyDispatchWorktree } from './codex-dispatch-project.ts';
import { implementationPresentation } from './implementation-result.ts';
import type issueProgression from './issue-progression.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import type { ManagedIssue } from './managed-issue.ts';

/** Prepare or reconcile a native turn after the caller verifies the issue, policy and checkout. */
export default async function advanceCodexWorkTurn(
  record: DispatchRecord,
  context: CodexWorkContext,
  verified: {
    admitted: ManagedIssue;
    selection: AssessmentSelection;
    found: DispatchNativeThread & { turnId: string };
    transition: ReturnType<typeof issueProgression>;
    liveMode: 'plan' | 'work' | 'auto';
    authorizeLive(): Promise<unknown>;
    resumeBlocked: boolean;
    blockedTurnId: string | undefined;
  },
) {
  const {
    input,
    current,
    deps,
    caller,
    activation,
    schedule,
    native,
    continuationNative,
    git,
    occurrence,
    save,
  } = context;
  const { admitted, found, transition, liveMode, authorizeLive, resumeBlocked, blockedTurnId } =
    verified;
  let selection = verified.selection;
  const work = record.continuation!;
  const retryDenied = input.action === 'retry-denied';
  const retry = input.action === 'retry' || retryDenied;
  if (input.action === 'context' && !work.attempt && !work.binding) {
    const unresolved = (reason: string) => ({
      status: 'unresolved' as const,
      id: record.id,
      code: 'continuation-turn-state-unresolved',
      reason,
      instruction:
        'Preserve the assessment, chat and worktree. Reconcile the current native turn through its owning workflow; do not force a send or treat an interrupted turn as active.',
    });
    if (found.turnId !== record.resultTurnId && context.operatorInput?.turnId !== found.turnId)
      return { ready: false as const, response: unresolved('assessment-turn-changed') };
    if (found.turnEnded || ['completed', 'failed'].includes(found.turnStatus ?? ''))
      return { ready: false as const, response: unresolved('assessment-turn-ended') };
    if (transition.status !== 'ready') throw new WorkflowPolicyHeld(transition.reason);
    if (
      (!context.operatorInput && record.stageReceipt?.binding.turnId !== found.turnId) ||
      record.stageReceipt?.resultDigest !== automationHash(record.result)
    )
      throw new Error('continuation-assessment-changed');
    if (found.turnStatus === 'interrupted') {
      const assessmentDigest = automationHash(record.result);
      if (
        work.observation &&
        (work.observation.turnId !== found.turnId ||
          work.observation.assessmentDigest !== assessmentDigest)
      )
        throw new Error('continuation-observation-binding-changed');
      if (!work.observation) {
        work.observation = {
          turnId: found.turnId,
          afterItemId: await native.intakeBoundary(record.threadId!, found.turnId),
          assessmentDigest,
        };
        await save();
      }
      const observed = await context.observeTurn?.({
        threadId: record.threadId!,
        turnId: found.turnId,
        afterItemId: work.observation.afterItemId,
        summaries: record.assessmentSummaries,
      });
      if (observed?.status === 'denied') {
        work.phase = 'blocked';
        work.code = 'continuation-native-approval-denied';
        await save();
        return {
          ready: false as const,
          response: { status: 'blocked' as const, id: record.id, code: work.code },
        };
      }
      if (observed?.status !== 'active')
        return {
          ready: false as const,
          response: {
            ...unresolved(
              observed?.status === 'unresolved' ? observed.reason : 'native-observation-required',
            ),
            status: 'observation-required' as const,
            request: {
              tool: 'read_thread',
              arguments: { threadId: record.threadId!, turnLimit: 1, includeOutputs: false },
            },
            instruction:
              'Call the native Codex read_thread tool with these exact arguments, then call continuation context again with this retained id. The runtime verifies the actual native receipt; do not submit status JSON. If the tool is unavailable or denied, stop and report continuation-turn-state-unresolved. Preserve the assessment and work; never force a coordinator send.',
          },
        };
      work.observation.receiptId = observed.receiptId;
      await authorizeLive();
    }
    record.progression = { ...transition.progression, workOwner: 'issue' };
    work.assessmentDigest = automationHash(record.result);
    work.attempt = {
      id: automationHash({
        id: record.id,
        assessmentTurn: found.turnId,
        result: work.assessmentDigest,
      }),
      origin: context.operatorInput ? 'input' : 'assessment',
      ...(context.operatorInput ? { inputId: context.operatorInput.inputId } : {}),
      sourceThreadId: record.threadId!,
      sourceTurnId: found.turnId,
      beforeTurnId: found.turnId,
      turnId: found.turnId,
      request: {
        threadId: record.threadId!,
        prompt: 'Continue the recorded assessment through implementation and managed PR delivery.',
      },
    };
    work.phase = 'running';
    await save();
  }
  if (!work.attempt) {
    if (
      input.action !== 'next' ||
      !occurrence ||
      (work.retries?.length
        ? !['completed', 'failed', 'interrupted'].includes(found.turnStatus ?? '')
        : found.turnStatus !== 'completed') ||
      !['idle', 'notLoaded'].includes(found.status)
    )
      return { ready: false as const, response: undefined };
    if (transition.status !== 'ready') throw new WorkflowPolicyHeld(transition.reason);
    record.progression = { ...transition.progression, workOwner: 'issue' };
    work.assessmentDigest = automationHash(record.result);
    if (liveMode === 'auto') work.assessmentSelectionDigest = automationHash(record.assessment);
    const id = automationHash({
      id: record.id,
      assessment: work.assessmentDigest,
      selection: work.selection,
      before: found.turnId,
      ...(work.retries?.length ? { retry: work.retries.length } : {}),
    });
    work.attempt = {
      id,
      sourceThreadId: activation.sourceThreadId,
      sourceTurnId: occurrence.id,
      beforeTurnId: found.turnId,
      request: {
        threadId: record.threadId!,
        prompt:
          'Continue this managed issue through implementation and pull-request delivery. Reconcile the latest conversation with the retained plan first; honor newer user instructions, including cancellation, before changing files. The activated workflow authorizes this sequence after its recorded assessment decision; do not request routine stage approval. Before editing, call continuationRuntime from the newest trusted Agent System context with JSON on stdin: ' +
          JSON.stringify({ action: 'context', id: record.id }) +
          '. Proceed only after verified context; follow its retained assessment, implementation selection, and instructions. Stop on substantive blockers or native denial. Continuation receipt: ' +
          id +
          '.',
      },
    };
    delete record.nativeInactive;
    work.phase = 'prepared';
    delete work.retry;
    delete work.retryAfter;
    await save();
    return {
      ready: false as const,
      response: { status: 'prepared' as const, id: record.id, request: work.attempt.request },
    };
  }
  let activeAttempt = work.publicationAttempt ?? work.attempt;
  let receipt = await continuationNative(
    record.sourceThreadId,
    activeAttempt,
    record.assessmentSummaries,
  );
  delete work.retry;
  delete work.retryAfter;
  if (retryDenied) {
    if (
      receipt.status !== 'blocked' ||
      !('rejection' in receipt) ||
      !receipt.rejection ||
      work.binding ||
      activeAttempt.turnId ||
      work.result ||
      work.publicationAttempt ||
      record.delivery
    )
      throw new Error('continuation-denial-unverified');
    if (found.turnId !== activeAttempt.beforeTurnId)
      throw new Error('continuation-denial-context-changed');
    if (found.turnStatus !== 'completed' || !['idle', 'notLoaded'].includes(found.status))
      throw new Error('continuation-retry-chat-active');
    await verifyDispatchWorktree(
      record.project!,
      found.cwd,
      admitted.repository.owner.login + '/' + admitted.repository.name,
      git,
    );
    const digest = automationHash({ record, schedule: schedule?.current, receipt });
    if (input.digest === undefined)
      return {
        ready: false as const,
        response: {
          status: 'retry-available' as const,
          id: record.id,
          digest,
          threadId: record.threadId!,
          rejection: receipt.rejection,
          instruction:
            'Only explicit operator reapproval of this rejected call authorizes retry-denied with this digest and approvedCallId. Preserve the rejected attempt and queue one new handoff for scheduled intake; native approval still applies.',
        },
      };
    if (input.digest !== digest) throw new Error('continuation-retry-stale');
    if (input.approvedCallId !== receipt.rejection.callId)
      throw new Error('continuation-denial-approval-required');
    work.retries = [
      ...(work.retries ?? []),
      {
        attempt: activeAttempt,
        rejection: receipt.rejection,
        resumeAfterTurnId: found.turnId,
        at: (deps.now ?? Date.now)(),
        by: caller,
      },
    ];
    delete work.attempt;
    delete work.code;
    work.phase = 'waiting';
    await save();
    return {
      ready: false as const,
      response: { status: 'retry-ready' as const, id: record.id, threadId: record.threadId! },
    };
  }
  if (retry && work.phase === 'prepared' && receipt.status !== 'mismatch')
    throw new Error('continuation-retry-unavailable');
  if (receipt.status === 'blocked' || (receipt.status === 'mismatch' && !retry)) {
    work.phase = 'blocked';
    work.code = receipt.code;
    await save();
    return {
      ready: false as const,
      response: { status: 'blocked' as const, id: record.id, code: work.code },
    };
  }
  if (retry && receipt.status === 'mismatch') {
    if (work.binding || work.result || work.publicationAttempt || record.delivery)
      throw new Error('continuation-retry-unavailable');
    await verifyDispatchWorktree(
      record.project!,
      found.cwd,
      admitted.repository.owner.login + '/' + admitted.repository.name,
      git,
    );
  }
  if (receipt.status !== 'verified' && !(retry && receipt.status === 'mismatch')) {
    if (!occurrence) throw new Error('continuation-send-unverified');
    return {
      ready: false as const,
      response: { status: 'pending' as const, id: record.id, code: 'continuation-send-unverified' },
    };
  }
  const completedTurnId =
    work.resultSource?.turnId ?? work.activeTurnId ?? work.binding?.turnId ?? work.attempt?.turnId;
  const workflowTurn = [
    record.resultTurnId,
    receipt.turnId,
    work.attempt?.turnId,
    work.publicationAttempt?.turnId,
    ...(work.retries?.map(({ attempt }) => attempt.turnId) ?? []),
    ...(record.feedback?.events.map(({ attempt }) => attempt?.turnId) ?? []),
  ].includes(found.turnId);
  const revisionInput =
    context.operatorInput ??
    (work.revisionSource?.turnId === found.turnId ? work.revisionSource : undefined) ??
    (input.action === 'context' &&
    work.result?.outcome === 'done' &&
    !workflowTurn &&
    found.followUpUserTurn &&
    found.turnId !== completedTurnId
      ? await native.operatorInput(record.threadId!)
      : undefined);
  const revision = Boolean(
    !workflowTurn &&
    revisionInput &&
    revisionInput.turnId === found.turnId &&
    implementationRevision(work, revisionInput, input.action === 'context', completedTurnId),
  );
  if (revision && revisionInput) {
    const revisionAttempt = {
      ...work.attempt,
      id: automationHash({ attempt: work.attempt.id, source: revisionInput }),
      origin: 'input' as const,
      inputId: revisionInput.inputId,
      sourceThreadId: record.threadId!,
      sourceTurnId: revisionInput.turnId,
      beforeTurnId: revisionInput.turnId,
      turnId: revisionInput.turnId,
      request: { threadId: record.threadId!, prompt: 'Continue the authorized revision.' },
    };
    const currentReceipt = await continuationNative(
      record.sourceThreadId,
      revisionAttempt,
      record.assessmentSummaries,
    );
    if (currentReceipt.status !== 'verified' || currentReceipt.turnId !== found.turnId) {
      if (currentReceipt.status === 'blocked') {
        work.phase = 'blocked';
        work.code = currentReceipt.code;
        await save();
        return {
          ready: false as const,
          response: { status: 'blocked' as const, id: record.id, code: work.code },
        };
      }
      throw new Error('continuation-input-unverified');
    }
    if (input.action === 'context') {
      (work.resultHistory ??= []).push({ source: work.resultSource, result: work.result! });
      delete work.result;
      delete work.resultSource;
      for (const previous of [work.attempt, work.publicationAttempt]) {
        if (previous)
          (work.retries ??= []).push({
            attempt: previous,
            ...(work.binding ? { binding: work.binding } : {}),
            at: (deps.now ?? Date.now)(),
            by: caller,
          });
      }
      work.attempt = revisionAttempt;
      activeAttempt = revisionAttempt;
      receipt = currentReceipt;
      delete work.binding;
      delete work.publicationAttempt;
      work.revisionSource = revisionInput;
      work.activeTurnId = found.turnId;
      work.phase = 'running';
      selection = (
        await selectWorkflowStage({
          stage: 'implementation',
          configuration: {
            ...current.manifest.github?.notifications?.issueAssignment?.implementation,
            ...record.manualIssue?.selections?.implementation,
          },
          workspace: current.workspace,
          observedAt: (deps.now ?? Date.now)(),
          resolveSkill: (id) => native.assessmentSkill(found.cwd, id),
        })
      ).selection;
    }
  }
  if (activeAttempt.turnId && activeAttempt.turnId !== receipt.turnId)
    throw new Error('continuation-turn-changed');
  if (
    found.turnId !== (receipt.status === 'mismatch' ? receipt.latestTurnId : receipt.turnId) &&
    found.turnId !== work.activeTurnId
  ) {
    if (retry) throw new Error('continuation-retry-context-changed');
    if (input.action === 'context' && caller === record.threadId! && found.followUpUserTurn) {
      work.activeTurnId = found.turnId;
    } else
      return {
        ready: false as const,
        response: {
          status: 'pending' as const,
          id: record.id,
          code: 'continuation-conversation-advanced',
          instructions:
            'The issue conversation has advanced. Reconcile current work in that chat through continuation context; do not resend the implementation request or overwrite newer user direction.',
        },
      };
  }
  if (resumeBlocked) {
    if (!found.followUpUserTurn || !blockedTurnId || found.turnId === blockedTurnId)
      return {
        ready: false as const,
        response: { status: 'blocked' as const, id: record.id, result: work.result },
      };
    work.phase = 'running';
    work.activeTurnId = found.turnId;
    await save();
  }
  if (work.phase === 'clarification-needed') {
    if (
      input.action === 'context' &&
      found.followUpUserTurn &&
      found.turnId !== work.clarificationTurnId
    ) {
      work.phase = 'running';
      work.activeTurnId = found.turnId;
      await save();
    } else
      return {
        ready: false as const,
        response: {
          status: 'clarification-needed' as const,
          id: record.id,
          questions: work.result?.outcome === 'clarification-needed' ? work.result.questions : [],
          presentation: work.result && implementationPresentation(work.result),
        },
      };
  }
  if (retry) {
    if (!receipt.ended || !['idle', 'notLoaded'].includes(found.status))
      throw new Error('continuation-retry-chat-active');
    const digest = automationHash({
      record,
      schedule: schedule?.current,
      turnId: receipt.turnId,
      ...(receipt.status === 'mismatch' ? { receipt, resumeAfterTurnId: found.turnId } : {}),
    });
    if (input.digest === undefined)
      return {
        ready: false as const,
        response: {
          status: 'retry-available' as const,
          id: record.id,
          digest,
          threadId: record.threadId!,
          instruction:
            'Retain the plan, chat, worktree, and previous attempt. Queue one new implementation handoff for the next scheduled occurrence; do not send it manually.',
        },
      };
    if (input.digest !== digest) throw new Error('continuation-retry-stale');
    work.retries = [
      ...(work.retries ?? []),
      {
        attempt: { ...activeAttempt, turnId: receipt.turnId },
        ...(receipt.status === 'mismatch'
          ? {
              resumeAfterTurnId: found.turnId,
              mismatch: {
                callId: receipt.callId,
                requestDigest: receipt.requestDigest,
                turnId: receipt.turnId,
              },
            }
          : {}),
        ...(work.binding ? { binding: work.binding } : {}),
        at: (deps.now ?? Date.now)(),
        by: caller,
      },
    ];
    delete work.attempt;
    delete work.binding;
    delete work.activeTurnId;
    delete work.code;
    work.phase = 'waiting';
    await save();
    return {
      ready: false as const,
      response: { status: 'retry-ready' as const, id: record.id, threadId: record.threadId! },
    };
  }
  const currentTurnEnded = work.activeTurnId
    ? ['completed', 'failed', 'interrupted'].includes(found.turnStatus ?? '')
    : receipt.ended;
  activeAttempt.turnId = receipt.turnId;
  if (work.phase === 'prepared') work.phase = 'running';
  work.binding ??= {
    admissionId: admitted.id,
    workflow: 'issue-assignment',
    repositoryId: admitted.repository.nodeId,
    subjectId: admitted.issue.nodeId,
    threadId: record.threadId!,
    turnId: receipt.turnId,
    worktree: found.cwd,
    dispatchDigest: automationHash(work.attempt),
    policyDigest: work.policyDigest,
    selectionDigest: automationHash(work.selection),
    routingDigest: automationHash(record.request),
    evidenceDigest: work.assessmentDigest!,
  };
  if (input.action === 'context' && record.progression) record.progression.workOwner = 'issue';
  await save();
  return {
    ready: true as const,
    activeAttempt,
    receipt,
    currentTurnEnded,
    selection,
    revisionInput,
  };
}
