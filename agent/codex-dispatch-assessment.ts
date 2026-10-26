import { dispatchAdmission, type ManagedIssue as IntakeRecord } from './managed-issue.ts';
import { realpath } from 'node:fs/promises';
import readRetainedHistory from './read-retained-history.ts';

import assessmentHandoff from './assessment-handoff.ts';
import assessmentSubmission from './assessment-submission.ts';
import {
  assessmentDecisionMode,
  assessmentResultContextSchema,
  parseAssessmentSubmission,
  type AssessmentResult,
} from './assessment-result.ts';
import {
  assessmentSummaryInstructions,
  type AssessmentSummaryRequest,
} from './assessment-summary-state.ts';
import assessmentSummary from './assessment-summary.ts';
import { automationHash } from './automation-hash.ts';
import codexAssessmentInstructions, {
  autoAssessmentInstructions,
} from './codex-assessment-instructions.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import {
  type CodexDispatchNative,
  code,
  repository,
  revalidateDispatchAssignment,
  withNative,
  type CodexDispatchDependencies,
  type CodexDispatchTransaction,
  type CodexDispatchSelection as Selection,
} from './codex-dispatch-context.ts';

import { verifyDispatchWorktree } from './codex-dispatch-project.ts';
import codexIssueBranch from './codex-issue-branch.ts';
import { notice } from './codex-dispatch-reporting.ts';
import { type default as CodexDispatchStore, type DispatchRecord } from './codex-dispatch-state.ts';

import connectCodexFeedback from './codex-feedback-client.ts';
import redactCodexFeedback from './codex-feedback-redaction.ts';
import codexSummaryAuthority from './codex-summary-authority.ts';
import codexSessionSettings from './codex-session-settings.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import assessmentPresentation from './dispatch-presentation.ts';
import recordDispatchResult from './dispatch-result.ts';
import selectFeedbackStage from './feedback-stage.ts';
import { feedbackWorkContext } from './feedback-work.ts';
import issueProgression from './issue-progression.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { requireWorkflowSchedule } from './workflow-result.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import workflowRecovery from './workflow-recovery.ts';

export async function presentDispatch(
  input: Record<string, unknown>,
  current: Selection,
  store: CodexDispatchStore,
  caller: string,
  deps: CodexDispatchDependencies,
) {
  const record = (await store.read()).records.find((entry) => entry.id === input.id);
  const intake = record && dispatchAdmission(record, (await current.store.read())?.records ?? []);
  if (record?.retainedHistory?.terminal) {
    if (record.threadId !== caller || !intake)
      throw new Error('dispatch-assessment-caller-mismatch');
    return {
      status: 'historical' as const,
      id: record.id,
      history: await readRetainedHistory(record, store.history, (deps.now ?? Date.now)()),
    };
  }
  if (
    !record?.request ||
    !record.result ||
    !record.threadId ||
    record.threadId !== caller ||
    !intake
  )
    throw new Error('dispatch-assessment-caller-mismatch');
  return withNative(current, deps, async (native) => {
    const found = await native.find({
      sourceThreadId: record.sourceThreadId,
      prompt: record.request!.prompt,
      createdAfter: record.createdAt,
      threadId: record.threadId,
    });
    if (!found || found.id !== caller) throw new Error('dispatch-native-binding-mismatch');
    return {
      status: 'presented' as const,
      retained: true,
      id: record.id,
      ...(input.includeDetails === true && record.retainedHistory
        ? {
            history: await readRetainedHistory(record, store.history, (deps.now ?? Date.now)()),
          }
        : {}),
      presentation: assessmentPresentation(
        record.result!,
        { ...record, effective: codexSessionSettings(record, found) },
        intake,
        current.workspace,
        {
          debug: current.manifest.debug,
          includeDetails: input.includeDetails === true,
        },
      ),
      instruction:
        'Show this complete saved assessment. This read does not authorize assessment, implementation, or publication.',
    };
  });
}
export async function handoffDispatch(
  input: Record<string, unknown>,
  current: Selection,
  store: CodexDispatchStore,
  caller: string,
  deps: CodexDispatchDependencies,
) {
  return store.exclusive(async (state, save) => {
    const record = state.records.find((entry) => entry.id === input.id);
    if (
      !record?.request ||
      !record.project ||
      !record.threadId ||
      !record.worktree ||
      record.reset ||
      record.retired ||
      record.retirement
    )
      throw new Error('dispatch-handoff-unavailable');
    if (
      caller === record.sourceThreadId ||
      state.records.some(
        (entry) =>
          entry.id !== record.id && [entry.threadId, entry.receiptThreadId].includes(caller),
      )
    )
      throw new Error('dispatch-handoff-caller-mismatch');
    const admitted = await current.store.read();
    const intake = dispatchAdmission(record, admitted?.records ?? []);
    if (!intake) throw new Error('dispatch-intake-record-missing');
    const native = await withNative(current, deps, (host) =>
      host.find({
        sourceThreadId: record.sourceThreadId,
        prompt: record.request!.prompt,
        createdAfter: record.createdAt,
        threadId: record.threadId,
      }),
    );
    if (
      !native ||
      native.id !== record.threadId ||
      (await realpath(native.cwd)) !== (await realpath(record.worktree))
    )
      throw new Error('dispatch-native-readback-diverged');
    await verifyDispatchWorktree(
      record.project,
      native.cwd,
      repository(intake),
      deps.git,
      'handoff',
    );
    const retainedAssessment = record.result ? { previousResult: record.result } : {};
    if (record.handoff)
      return {
        status: 'handed-off' as const,
        changed: false,
        id: record.id,
        threadId: record.threadId,
        issueBranch: record.issueBranch?.name,
        ...retainedAssessment,
      };
    if (record.continuation?.phase === 'cancelled') throw new Error('implementation-cancelled');
    if (
      record.continuation?.phase === 'blocked' &&
      (['continuation-native-send-failed', 'continuation-native-approval-denied'].includes(
        record.continuation.code ?? '',
      ) ||
        (record.continuation.result?.outcome === 'blocked' &&
          (!native.followUpUserTurn ||
            native.turnId ===
              (record.continuation.blockedTurnId ??
                record.continuation.activeTurnId ??
                record.continuation.binding?.turnId))))
    )
      throw new Error(record.continuation.code ?? 'continuation-implementation-blocked');
    const transition = issueProgression(record, {
      mode:
        record.manualIssue?.selections?.mode ??
        current.manifest.github?.notifications?.issueAssignment?.mode ??
        'auto',
      now: (deps.now ?? Date.now)(),
      operator: native.followUpUserTurn,
    });
    if (!native.turnId || (!native.followUpUserTurn && transition.status !== 'ready'))
      throw new WorkflowPolicyHeld(
        transition.status === 'ready' ? 'native-turn-unavailable' : transition.reason,
      );
    // polling and presentation do not change the work being handed off; retain all authority and result fields.
    const digest = automationHash({
      record: {
        ...record,
        feedback: undefined,
        intakeReportedAt: undefined,
        renameRequested: undefined,
      },
      turnId: native.turnId,
    });
    if (input.digest === undefined)
      return {
        status: 'handoff-available' as const,
        id: record.id,
        digest,
        threadId: record.threadId,
        ...retainedAssessment,
        instruction:
          'Apply this handoff when the live workflow or explicit user request permits implementation. It records the transition and preserves the assessment and checkout. Implementation includes ordinary PR delivery; honor explicit restrictions and native denials.',
      };
    if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
    if (transition.status === 'ready')
      record.progression = { ...transition.progression, workOwner: 'issue' };
    await codexIssueBranch({
      record,
      records: state.records,
      intake,
      workspace: current.workspace,
      agentId: current.manifest.agent.id,
      git: deps.git,
      save,
      prepare: true,
    });
    record.handoff = { at: (deps.now ?? Date.now)(), by: caller, turnId: native.turnId };
    const response = notice(record, intake);
    await save();
    return { ...response, issueBranch: record.issueBranch?.name, ...retainedAssessment };
  }, true);
}
export async function assessDispatch(
  action: string,
  input: Record<string, unknown>,
  record: DispatchRecord,
  intake: IntakeRecord,
  native: NonNullable<Awaited<ReturnType<CodexDispatchNative['find']>>>,
  tx: CodexDispatchTransaction,
) {
  const { pluginData, current, deps, now, signal, save, fresh } = tx;
  if (action === 'context')
    record.issueMode =
      record.manualIssue?.selections?.mode ??
      current.manifest.github?.notifications?.issueAssignment?.mode ??
      'auto';
  if (action === 'summary') {
    if (!record.result || !native.turnId) throw new Error('assessment-summary-source-unavailable');
    const activate = () =>
      (deps.activation ?? inspectCodexDispatchActivation)(
        pluginData,
        { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
        false,
        true,
        'assessment-summary',
      );
    const summaryAuthority = record.manualIssue ? { schedule: undefined } : await activate();
    if (!summaryAuthority.schedule && !record.manualIssue)
      throw new Error('workflow-schedule-reconciliation-required');
    if (summaryAuthority.schedule)
      requireWorkflowSchedule(
        summaryAuthority.schedule.saved,
        summaryAuthority.schedule.current,
        'assessment-summary',
      );
    const authorityDigest = automationHash(
      summaryAuthority.schedule ?? record.manualIssue!.initiation,
    );
    return assessmentSummary({
      record,
      intake,
      action: input as unknown as AssessmentSummaryRequest,
      turnId: native.turnId,
      recovery: true,
      authorityDigest,
      presentation: assessmentPresentation(record.result, record, intake, current.workspace, {
        debug: current.manifest.debug,
      }),
      save,
      publicationCommand: (digest) =>
        [
          process.execPath,
          process.argv[1]!,
          'dispatch',
          'summary',
          'publish',
          '--plugin-data',
          pluginData,
        ]
          .map((value) => "'" + value.replaceAll("'", "'\\''") + "'")
          .join(' ') +
        " <<'AGENT_SYSTEM_INPUT'\n" +
        JSON.stringify({ action: 'summary', id: record.id, operation: 'publish', digest }) +
        '\nAGENT_SYSTEM_INPUT',
      redact: redactCodexFeedback,
      authorize: async () => {
        await fresh();
        if (input.operation !== 'reconcile' && input.operation !== 'hold') {
          if (deps.summaryAuthority) await deps.summaryAuthority(native.id, native.turnId!);
          else {
            const connection = await connectCodexThreads(current.workspace, current.codexHome);
            try {
              await codexSummaryAuthority(connection.request, native.id, native.turnId!, [
                record.resultTurnId!,
                ...(record.assessmentSummaries ?? []).map((summary) => summary.turnId),
              ]);
            } finally {
              await connection.close();
            }
          }
        }
        if (!record.manualIssue) await activate();
        await revalidateDispatchAssignment(current, intake, deps, signal, true, record);
      },
      select: async (previous) =>
        (
          await selectFeedbackStage({
            policy: current.policy!.policy,
            workflow: 'issue-assignment',
            workspace: current.workspace,
            observedAt: previous?.observedAt ?? now,
            resolveSkill: (id) =>
              withNative(current, deps, (host) => host.assessmentSkill(native.cwd, id)),
          })
        ).selection,
      connect: async () => {
        const provider = await (deps.feedbackConnect ?? connectCodexFeedback)(
          current.workspace,
          signal,
        );
        return { client: provider.comments, authorLogin: provider.comments.identity.login };
      },
    });
  }
  if (action === 'context') {
    const assessment = (
      await selectWorkflowStage({
        stage: 'assessment',
        configuration: {
          ...current.manifest.github?.notifications?.issueAssignment?.assessment,
          ...record.manualIssue?.selections?.assessment,
        },
        workspace: current.workspace,
        observedAt: now,
        resolveSkill: (id) =>
          withNative(current, deps, (host) => host.assessmentSkill(native.cwd, id)),
      })
    ).selection;
    // historical selection remains evidence; each invocation uses live configuration.
    record.assessment ??= assessment;
    await save();
    return {
      status: 'verified' as const,
      assignmentObservation: record.assignmentObservation,
      entry: 'managed',
      assignmentWarning:
        record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
      id: record.id,
      project: record.project,
      routing: JSON.parse(record.routing!),
      routingNote: record.routingNote,
      effective: record.effective,
      evidence: JSON.parse(record.context!),
      assessment,
      feedbackWork: feedbackWorkContext(record),
      ...(native.turnId ? { currentTurnId: native.turnId } : {}),
      ...(record.result
        ? {
            previousResult: record.result,
            handoff: assessmentHandoff(
              record,
              record.manualIssue?.selections?.mode ??
                current.manifest.github?.notifications?.issueAssignment?.mode ??
                'auto',
              'codex',
            ),
            previousResultDigest: automationHash(record.result),
            previousResultTurnId: record.resultTurnId,
            previousPresentation: assessmentPresentation(
              record.result,
              record,
              intake,
              current.workspace,
              {
                debug: current.manifest.debug,
                manifestPath:
                  current.manifestSources?.['/github/issue-assignment/assessment/guidance']?.path ??
                  current.manifestPath,
              },
            ),
          }
        : {}),
      resultContract: 'assessment-result/v1',
      resultSchema: assessmentResultContextSchema,
      resultSubmission: assessmentSubmission({
        entry: 'managed',
        id: record.id,
        previousResultDigest: record.result ? automationHash(record.result) : undefined,
      }),
      mode:
        record.manualIssue?.selections?.mode ??
        current.manifest.github?.notifications?.issueAssignment?.mode ??
        'auto',
      instructions:
        'Read feedbackWork for retained plan revisions and responses before interpreting the current input. Historical responses supply context, not fresh authorization. ' +
        codexAssessmentInstructions +
        (record.issueMode === 'auto' ? '\n\n' + autoAssessmentInstructions : ''),
    };
  }
  if (action === 'result') {
    const continuation = record.issueMode === 'auto' ? record.continuation : undefined;
    let result: AssessmentResult;
    try {
      result = parseAssessmentSubmission(input.result);
      if (record.issueMode === 'auto' && !result.decision)
        throw new Error('assessment-decision-required');
      if (
        record.continuation?.assessmentDigest &&
        record.continuation.assessmentDigest !== automationHash(result)
      )
        throw new Error('continuation-assessment-changed');
    } catch (error) {
      if (continuation && !['blocked', 'cancelled', 'complete'].includes(continuation.phase)) {
        continuation.phase = 'blocked';
        continuation.code = code(error);
        await save();
      }
      throw error;
    }
    if (!native.turnId) throw new Error('dispatch-native-turn-unavailable');
    recordDispatchResult({
      record,
      intake,
      threadId: native.id,
      turnId: native.turnId,
      worktree: native.cwd,
      policy: current.manifest.github?.notifications,
      result,
      previousResultDigest: input.previousResultDigest as string | undefined,
    });
    if (
      continuation?.phase === 'blocked' &&
      !continuation.assessmentDigest &&
      !continuation.attempt &&
      !continuation.binding &&
      [
        'assessment-result-invalid',
        'assessment-result-incomplete',
        'assessment-decision-required',
        'assessment-decision-conflict',
      ].includes(continuation.code ?? '')
    ) {
      continuation.phase = 'waiting';
      delete continuation.code;
    }
    if (continuation?.phase === 'waiting' && assessmentDecisionMode(result.decision) === 'plan') {
      continuation.phase = 'blocked';
      continuation.code = 'continuation-auto-wait';
    }
    const presentation = assessmentPresentation(result, record, intake, current.workspace, {
      debug: current.manifest.debug,
      manifestPath:
        current.manifestSources?.['/github/issue-assignment/assessment/guidance']?.path ??
        current.manifestPath,
    });
    await save();
    return {
      status: 'recorded' as const,
      id: record.id,
      outcome: result.outcome,
      previousResultDigest: automationHash(result),
      handoff: assessmentHandoff(
        record,
        record.manualIssue?.selections?.mode ??
          current.manifest.github?.notifications?.issueAssignment?.mode ??
          'auto',
        'codex',
      ),
      presentation,
      instruction: assessmentSummaryInstructions('codex'),
    };
  }
  throw new Error('dispatch-action-invalid');
}
