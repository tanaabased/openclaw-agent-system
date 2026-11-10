import { realpath } from 'node:fs/promises';
import assessmentMaterial from './assessment-material.ts';
import { assessmentPresentationRequest } from './assessment-render.ts';
import { assessmentResultContextSchema } from './assessment-result.ts';
import { automationHash } from './automation-hash.ts';
import codexAssessmentInstructions, {
  autoAssessmentInstructions,
} from './codex-assessment-instructions.ts';
import { observeCodexActivity } from './codex-capacity-reconcile.ts';
import {
  repository,
  withNative,
  type CodexDispatchDependencies,
  type CodexDispatchNative,
  type CodexDispatchTransaction,
  type CodexDispatchSelection as Selection,
} from './codex-dispatch-context.ts';
import { verifyDispatchWorktree } from './codex-dispatch-project.ts';
import { notice } from './codex-dispatch-reporting.ts';
import { type default as CodexDispatchStore, type DispatchRecord } from './codex-dispatch-state.ts';
import codexIssueBranch from './codex-issue-branch.ts';
import type { ImplementationMaterialRead } from './implementation-material.ts';
import issueProgression from './issue-progression.ts';
import issueWorkflowMode from './issue-workflow-mode.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import {
  dispatchAdmission,
  managedTargetUrl,
  type ManagedIssue as IntakeRecord,
} from './managed-issue.ts';
import workflowRecovery from './workflow-recovery.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
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
    await verifyDispatchWorktree(
      record.project,
      native.cwd,
      repository(intake),
      deps.git,
      'handoff',
    );
    if (record.nativeWork?.cancelled) throw new Error('implementation-cancelled');
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
    if (!input.apply && input.digest === undefined)
      return {
        status: 'handoff-available' as const,
        id: record.id,
        digest,
        threadId: record.threadId,
        instruction:
          'Apply this handoff when the live workflow or explicit user request permits implementation. It records the transition and preserves the assessment and checkout. Implementation includes ordinary PR delivery; honor explicit restrictions and native denials.',
      };
    if (!input.apply && input.digest !== digest) throw new Error('dispatch-recovery-stale');
    if (transition.status === 'ready') record.progression = { ...transition.progression };
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
  const { current, deps, now, save, fresh } = tx;
  if (action === 'context')
    record.issueMode = issueWorkflowMode(current.manifest.github?.notifications, record);
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
      recording: 'native-context' as const,
      resultContract: 'assessment-result/v1',
      resultSchema: assessmentResultContextSchema,
      presentationRequest: {
        ...assessmentPresentationRequest(managedTargetUrl(intake)),
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
  throw new Error('dispatch-action-invalid');
}
