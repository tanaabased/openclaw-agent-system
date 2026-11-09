import nativeClarification from './native-clarification.ts';
import nativeTaskInstructions from './native-task-instructions.ts';
import implementationContext from './implementation-context.ts';
import workflowRecovery from './workflow-recovery.ts';
import implementationHandoff from './implementation-handoff.ts';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { Static } from 'typebox';

import { implementationPresentation } from './implementation-result.ts';
import { automationHash } from './automation-hash.ts';
import issueProgression, { type IssueProgression } from './issue-progression.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { operatorInputEvent, nativeInputEvent } from './openclaw-session-input.ts';
import { describeIssueSession, type DispatchCaller } from './openclaw-session-create.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';
import type { dispatchParameters } from '../tools/dispatch/tool-schema.ts';

export type OpenClawWorkAction = Extract<
  Static<typeof dispatchParameters>,
  {
    action: 'handoff' | 'implementation-context' | 'implementation-result' | 'delivery';
  }
>;

/** verify host-owned input custody; tool arguments never establish requester authority. */
export async function verifyOpenClawWork(input: {
  record: OpenClawDispatchRecord;
  caller: DispatchCaller;
  operator: boolean;
  feedback?: { inputId: string; message: string };
  mode: 'plan' | 'work' | 'auto';
  decision?: Parameters<typeof issueProgression>[1]['decision'];
  save?(): Promise<void>;
  now: number;
  request: DispatchRequest;
  config: OpenClawConfig;
}) {
  const { record, caller } = input;
  if (
    caller.sessionKey !== record.threadId ||
    caller.sessionId !== record.sessionCreation?.sessionId
  )
    throw new Error('dispatch-work-context-mismatch');
  await describeIssueSession(input.request, record, input.config);
  const operator =
    input.operator &&
    caller.runId !== record.firstTurn?.runId &&
    caller.runId !== record.assessmentTurn?.runId &&
    caller.runId !== record.decisionTurn?.runId &&
    caller.runId !== record.summaryRecovery?.turn.runId &&
    !record.previousSummaryTurns?.some(({ turn }) => turn.runId === caller.runId) &&
    !record.previousDecisionTurns?.some((turn) => turn.runId === caller.runId) &&
    caller.runId !== record.work?.implementation?.runId &&
    caller.runId !== record.work?.turn?.runId &&
    caller.runId !== record.work?.deliveryTurn?.runId &&
    !record.work?.previousTurns?.some(({ turn }) => turn.runId === caller.runId) &&
    !record.feedback?.events.some(
      (event) => event.turn?.runId === caller.runId || event.turn?.executionRunId === caller.runId,
    );
  const automatic = issueProgression(record, {
    mode: input.mode,
    now: input.now,
    decision: input.decision,
  });
  const transition =
    automatic.status === 'ready'
      ? automatic
      : issueProgression(record, {
          mode: input.mode,
          now: input.now,
          operator: operator || Boolean(input.feedback),
          decision: input.decision,
        });
  if (transition.status !== 'ready') throw new WorkflowPolicyHeld(transition.reason);
  const retained = [
    record.work?.operatorInput,
    record.work?.caller,
    record.work?.implementation,
    record.work?.publication,
    record.assessmentCaller,
  ];
  const context = {
    request: input.request,
    sessionKey: caller.sessionKey,
    sessionId: caller.sessionId,
    runId: caller.runId,
    retained,
  };
  const verifiedInput = input.feedback
    ? { runId: caller.runId, inputEventId: input.feedback.inputId, message: input.feedback.message }
    : automatic.status !== 'ready' || (operator && record.work?.result?.outcome === 'done')
      ? await operatorInputEvent({ ...context, senderIsOwner: operator })
      : await nativeInputEvent(context);
  const { runId, inputEventId } = verifiedInput;
  if (input.decision) {
    record.implementationDecision = input.decision;
    await input.save?.();
  }
  const message =
    'message' in verifiedInput && typeof verifiedInput.message === 'string'
      ? verifiedInput.message
      : undefined;
  return {
    source: { runId, inputEventId },
    message,
    progression: input.feedback
      ? { ...transition.progression, workOwner: 'issue' }
      : transition.progression,
  };
}

export default async function openClawWorkAction(input: {
  record: OpenClawDispatchRecord;
  caller: DispatchCaller;
  source: { runId: string; inputEventId: string };
  message?: string;
  progression: IssueProgression;
  action: Exclude<OpenClawWorkAction, { action: 'delivery' }>;
  now: number;
  assertCurrent(): Promise<void>;
  save(): Promise<void>;
}) {
  const { record, source, action } = input;
  await input.assertCurrent();
  if (action.action === 'handoff') {
    const digest = automationHash({
      id: record.id,
      source,
      permission: action.permission,
      work: record.work ?? null,
    });
    if (!action.apply && !action.digest)
      return {
        status: 'handoff-available',
        id: record.id,
        digest,
        permission: action.permission,
        instructions:
          'Apply this digest to record the single implementation transition. Work includes ordinary branch, commit, push, and PR delivery. Honor explicit user restrictions; this preview does not override cancellation or native denial.',
      };
    if (!action.apply && action.digest !== digest) throw new Error('dispatch-handoff-stale');
    record.work ??= {};
    if (action.permission !== 'publication')
      record.progression = { ...input.progression, workOwner: 'issue' };
    // publication-only input retains its own scope without entering implementation.
    if (action.permission !== 'publication') record.work.implementation ??= source;
    else record.work.publication = source;
    record.handoff ??= { at: input.now, by: input.caller.sessionKey, turnId: source.runId };
    await input.save();
    return {
      status: 'handed-off',
      id: record.id,
      instructions:
        'Call implementation-context before changing files, or delivery prepare for already implemented work. Use the current native conversation and preserve the worktree and selected model/effort. Continue within the verified task scope; implementation includes ordinary PR delivery. Honor explicit user restrictions without requiring another stage approval.',
    };
  }
  const resultSource = { turnId: source.runId, inputId: source.inputEventId };
  if (action.action === 'implementation-context') {
    if (action.material && (!record.work?.implementation || !record.work.caller))
      throw new Error('implementation-material-context-required');
    if (!action.material) {
      record.progression = { ...input.progression, workOwner: 'issue' };
      record.work ??= {};
      if (action.scope) record.work.scope = action.scope;
      record.handoff ??= { at: input.now, by: input.caller.sessionKey, turnId: source.runId };
      record.work.implementation ??= source;
      record.work.caller = source;
      await input.save();
    }
    if (!record.work) throw new Error('implementation-material-context-required');
    return {
      ...implementationContext({
        runtime: 'openclaw',
        id: record.id,
        path: record.worktree!,
        implementation: record.work.selection,
        scope: record.work.scope,
      }),
      issueStage: record.progression?.stage ?? 'planning',
      assignmentObservation: record.assignmentObservation,
      assignmentWarning:
        record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
      routing: record.routing && JSON.parse(record.routing),
      effective: record.effective,
      instructions: nativeTaskInstructions('openclaw'),
    };
  }
  if (!record.work?.caller || automationHash(record.work.caller) !== automationHash(source))
    throw new Error('implementation-context-missing');
  if (action.implementationResult.outcome === 'clarification-needed')
    return nativeClarification(record.id, implementationPresentation(action.implementationResult));
  const changed =
    record.work.result &&
    record.work.result.outcome !== 'clarification-needed' &&
    automationHash(record.work.result) !== automationHash(action.implementationResult);
  if (changed)
    (record.work.resultHistory ??= []).push({
      source: record.work.resultSource,
      result: record.work.result!,
    });
  record.work.resultSource = resultSource;
  record.work.result = action.implementationResult;
  delete record.work.revisionSource;
  if (record.work.code === 'implementation-result-missing') delete record.work.code;
  delete record.work.clarificationInput;
  await input.save();
  return {
    status: 'recorded',
    id: record.id,
    outcome: action.implementationResult.outcome,
    handoff: implementationHandoff(
      action.implementationResult.outcome,
      'openclaw',
      record.work.scope === 'local' ? { publication: false } : undefined,
    ),
    presentation: implementationPresentation(action.implementationResult),
  };
}
