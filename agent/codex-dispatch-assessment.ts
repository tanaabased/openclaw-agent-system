import { observeCodexActivity } from './codex-capacity-reconcile.ts';
import { hasDeliveredImplementation, nativeIssueContext } from './implementation-delivery.ts';
import assessmentMaterial from './assessment-material.ts';
import type { ImplementationMaterialRead } from './implementation-material.ts';
import issueWorkflowMode from './issue-workflow-mode.ts';
import {
  dispatchAdmission,
  managedTargetUrl,
  type ManagedIssue as IntakeRecord,
} from './managed-issue.ts';
import { realpath } from 'node:fs/promises';
import readRetainedHistory from './read-retained-history.ts';

import renderNativeAssessment, { assessmentPresentationRequest } from './assessment-render.ts';
import { assessmentResultContextSchema, parseAssessmentSubmission } from './assessment-result.ts';
import { type AssessmentSummaryRequest } from './assessment-summary-state.ts';
import assessmentSummary from './assessment-summary.ts';
import { automationHash } from './automation-hash.ts';
import codexAssessmentInstructions, {
  autoAssessmentInstructions,
} from './codex-assessment-instructions.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import {
  type CodexDispatchNative,
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
import assessmentPresentation, { dispatchAssessmentContext } from './dispatch-presentation.ts';
import selectFeedbackStage from './feedback-stage.ts';
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
      previousResult: record.result,
      previousResultDigest: automationHash(record.result),
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
          workflow: current.manifest.github?.notifications?.issueAssignment,
          routingManifestPath:
            current.manifestSources?.['/models/routing/guidance']?.path ?? current.manifestPath,
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
      record.supersededBy ||
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
      native.archived ||
      native.id !== record.threadId ||
      (await realpath(native.cwd)) !== (await realpath(record.worktree))
    )
      throw new Error('dispatch-native-readback-diverged');
    if (hasDeliveredImplementation(record)) return nativeIssueContext(record);
    await verifyDispatchWorktree(
      record.project,
      native.cwd,
      repository(intake),
      deps.git,
      'handoff',
    );
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
    if (record.handoff)
      return {
        status: 'handed-off' as const,
        changed: false,
        id: record.id,
        threadId: record.threadId,
        issueBranch: record.issueBranch?.name,
      };
    const operatorInput = native.followUpUserTurn
      ? await withNative(current, deps, (host) => host.operatorInput(record.threadId!))
      : undefined;
    if (operatorInput && operatorInput.turnId !== native.turnId)
      throw new Error('dispatch-native-readback-diverged');
    const transition = issueProgression(record, {
      mode: issueWorkflowMode(current.manifest.github?.notifications, record),
      now: (deps.now ?? Date.now)(),
      operator: Boolean(operatorInput),
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
        nativeInactive: undefined,
        capacityObservation: undefined,
        reservationVersion: undefined,
      },
      turnId: native.turnId,
      inputId: operatorInput?.inputId,
    });
    if (input.digest === undefined)
      return {
        status: 'handoff-available' as const,
        id: record.id,
        digest,
        threadId: record.threadId,
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
    record.handoff = {
      at: (deps.now ?? Date.now)(),
      by: caller,
      turnId: native.turnId,
      ...(operatorInput ? { inputId: operatorInput.inputId } : {}),
    };
    observeCodexActivity(record, native, (deps.now ?? Date.now)());
    const response = notice(record, intake);
    await save();
    return { ...response, issueBranch: record.issueBranch?.name };
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
    record.issueMode = issueWorkflowMode(current.manifest.github?.notifications, record);
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
      runtime: 'codex',
      record,
      intake,
      action: input as unknown as AssessmentSummaryRequest,
      turnId: native.turnId,
      recovery: true,
      authorityDigest,
      presentation: assessmentPresentation(record.result, record, intake, current.workspace, {
        debug: current.manifest.debug,
        workflow: current.manifest.github?.notifications?.issueAssignment,
        routingManifestPath:
          current.manifestSources?.['/models/routing/guidance']?.path ?? current.manifestPath,
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
    const evidence = { source: managedTargetUrl(intake) };
    await fresh();
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
    const context = {
      runtime: 'codex',
      status: 'verified' as const,
      assignmentObservation: record.assignmentObservation,
      entry: 'managed',
      assignmentWarning:
        record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
      id: record.id,
      project: { ...record.project, path: record.worktree },
      routing: JSON.parse(record.routing!),
      routingNote: record.routingNote,
      effective: record.effective,
      evidence,
      adoptedPullRequest: record.adoptedPullRequest,
      ...(record.predecessorId
        ? {
            predecessor: (() => {
              const previous = tx.state.records.find((entry) => entry.id === record.predecessorId);
              return {
                id: record.predecessorId,
                threadId: previous?.threadId,
                worktree: previous?.worktree,
                instruction:
                  'Preserved predecessor evidence is context, not current implementation or publication authority.',
              };
            })(),
          }
        : {}),
      assessment,
      ...(native.turnId ? { currentTurnId: native.turnId } : {}),
      previousResultDigest: record.result ? automationHash(record.result) : undefined,
      recording: 'native-context' as const,
      resultContract: 'assessment-result/v1',
      resultSchema: assessmentResultContextSchema,
      presentationRequest: {
        id: record.id,
        ...assessmentPresentationRequest(
          managedTargetUrl(intake),
          false,
          dispatchAssessmentContext(
            { ...record, assessment, stageReceipt: undefined },
            current.workspace,
            {
              debug: current.manifest.debug,
              workflow: current.manifest.github?.notifications?.issueAssignment,
              manifestPath: current.manifestPath,
              routingManifestPath:
                current.manifestSources?.['/models/routing/guidance']?.path ?? current.manifestPath,
            },
          ),
        ),
      },
      mode: issueWorkflowMode(current.manifest.github?.notifications, record),
      instructions:
        'When implementation context is needed, send continuationRequest unchanged to continuationRuntime context, adding a decision only when required.\n\n' +
        codexAssessmentInstructions +
        (record.issueMode === 'auto' ? '\n\n' + autoAssessmentInstructions : ''),
      continuationRequest: { action: 'context' as const, id: record.id },
    };
    return assessmentMaterial(
      context,
      { action: 'context', id: record.id },
      input.material as ImplementationMaterialRead | undefined,
    );
  }
  if (action === 'result') {
    const result = parseAssessmentSubmission(input.result);
    return {
      id: record.id,
      ...renderNativeAssessment({
        ...assessmentPresentationRequest(
          managedTargetUrl(intake),
          false,
          dispatchAssessmentContext(record, current.workspace, {
            debug: current.manifest.debug,
            workflow: current.manifest.github?.notifications?.issueAssignment,
            manifestPath: current.manifestPath,
          }),
        ),
        result: {
          ...result,
          reviewSummary:
            result.reviewSummary ??
            [
              result.summary,
              ...(result.outcome === 'clarification-needed'
                ? result.questions
                : result.outcome === 'operator-setup-blocker'
                  ? [result.remediation]
                  : []),
            ].join('\n\n'),
        },
      }),
    };
  }
  throw new Error('dispatch-action-invalid');
}
