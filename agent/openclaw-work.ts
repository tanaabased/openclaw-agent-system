import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { Static } from 'typebox';

import { implementationResultSchema, implementationPresentation } from './implementation-result.ts';
import { automationHash } from './automation-hash.ts';
import issueProgression, {
  retainedIssueProgression,
  type IssueProgression,
} from './issue-progression.ts';
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
  mode: 'plan' | 'work' | 'auto';
  now: number;
  request: DispatchRequest;
  config: OpenClawConfig;
}) {
  const { record, caller } = input;
  if (
    caller.sessionKey !== record.threadId ||
    caller.sessionId !== record.sessionCreation?.sessionId ||
    !record.result ||
    !record.stageReceipt ||
    (record.result.outcome !== 'plan-ready' && !retainedIssueProgression(record))
  )
    throw new Error('dispatch-work-context-mismatch');
  await describeIssueSession(input.request, record, input.config);
  const operator =
    input.operator &&
    caller.runId !== record.firstTurn?.runId &&
    caller.runId !== record.assessmentTurn?.runId &&
    caller.runId !== record.decisionTurn?.runId &&
    !record.feedback?.events.some((event) => event.turn?.runId === caller.runId);
  const automatic = issueProgression(record, { mode: input.mode, now: input.now });
  const transition =
    automatic.status === 'ready'
      ? automatic
      : issueProgression(record, { mode: input.mode, now: input.now, operator });
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
  const verifiedInput =
    automatic.status !== 'ready'
      ? await operatorInputEvent({ ...context, senderIsOwner: operator })
      : await nativeInputEvent(context);
  const { runId, inputEventId } = verifiedInput;
  const message =
    'message' in verifiedInput && typeof verifiedInput.message === 'string'
      ? verifiedInput.message
      : undefined;
  return { source: { runId, inputEventId }, message, progression: transition.progression };
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
  const assessmentDigest = automationHash(record.result);
  if (record.work && record.work.assessmentDigest !== assessmentDigest)
    throw new Error('dispatch-work-assessment-changed');
  await input.assertCurrent();
  if (action.action === 'handoff') {
    const digest = automationHash({
      id: record.id,
      source,
      assessmentDigest,
      permission: action.permission,
      work: record.work ?? null,
    });
    if (!action.digest)
      return {
        status: 'handoff-available',
        id: record.id,
        digest,
        permission: action.permission,
        assessment: record.result,
        instructions:
          'Apply this digest to record the single implementation transition. Work includes ordinary branch, commit, push, and PR delivery. Honor explicit user restrictions; this preview does not override cancellation or native denial.',
      };
    if (action.digest !== digest) throw new Error('dispatch-handoff-stale');
    record.work ??= { assessmentDigest };
    if (action.permission !== 'publication') record.progression = input.progression;
    // legacy permission spelling is accepted; implementation includes ordinary pr delivery.
    if (action.permission !== 'publication') record.work.implementation = source;
    else record.work.publication = source;
    record.handoff ??= { at: input.now, by: input.caller.sessionKey, turnId: source.runId };
    await input.save();
    return {
      status: 'handed-off',
      id: record.id,
      instructions:
        'Call implementation-context before changing files, or delivery prepare for already implemented work. Preserve the complete assessment, worktree, and selected model/effort. Continue within the verified task scope; implementation includes ordinary PR delivery. Honor explicit user restrictions without requiring another stage approval.',
    };
  }
  if (action.action === 'implementation-context') {
    if (
      record.work?.result?.outcome === 'clarification-needed' &&
      record.work.clarificationInput?.runId === source.runId
    )
      return {
        status: 'clarification-needed',
        id: record.id,
        presentation: implementationPresentation(record.work.result),
      };
    record.progression = input.progression;
    record.work ??= { assessmentDigest };
    record.handoff ??= { at: input.now, by: input.caller.sessionKey, turnId: source.runId };
    record.work.implementation ??= source;
    record.work.caller = source;
    if (!record.work.turn && record.resultTurnId === source.runId && input.message) {
      record.work.turn = {
        origin: 'assessment',
        runId: source.runId,
        message: input.message,
        status: 'consumed',
        consumedByEventId: source.inputEventId,
      };
    }
    await input.save();
    return {
      status: 'verified',
      runtime: 'openclaw',
      issueStage: record.progression?.stage ?? 'planning',
      id: record.id,
      project: { path: record.worktree },
      assessment: record.result,
      routing: record.routing && JSON.parse(record.routing),
      effective: record.effective,
      resultSchema: implementationResultSchema,
      previousImplementationResult: record.work.result,
      feedbackWork: record.feedback?.events
        .filter((event) => event.work)
        .map((event) => ({
          id: event.id,
          decision: event.work?.decision,
          result: event.work?.result,
        })),
      publicationAuthorized: true,
      deliveryOnly: record.work.result?.outcome === 'done',
      instructions:
        'When deliveryOnly is true, reconcile the recorded result and finish managed PR delivery without repeating implementation. Otherwise use the returned implementation skill and guidance in the existing worktree. Read feedbackWork for later resolved plans and partial implementation; it supplements the preserved original assessment. Preserve routing and prior work. Follow the current conversation and authorized plan; stop on cancellation or denial. Commit validated work and retain the complete outcome with implementation-result. For unanswered consequential requirements, submit clarification-needed with questions and fullResult, show its returned presentation, and wait for an answer. On a new input refresh this context, reconcile partial work, and resume without renewed approval. A done result permits managed PR delivery without a separate publication grant; honor explicit user restrictions. Do not use Codex runtime commands.',
    };
  }
  if (!record.work?.caller || automationHash(record.work.caller) !== automationHash(source))
    throw new Error('implementation-context-missing');
  if (
    record.work.result?.outcome === 'clarification-needed' &&
    record.work.clarificationInput?.runId === source.runId &&
    automationHash(record.work.result) !== automationHash(action.implementationResult)
  )
    throw new Error('implementation-answer-required');
  record.work.result = action.implementationResult;
  if (record.work.code === 'implementation-result-missing') delete record.work.code;
  if (action.implementationResult.outcome === 'clarification-needed')
    record.work.clarificationInput = source;
  else delete record.work.clarificationInput;
  await input.save();
  return {
    status: 'recorded',
    id: record.id,
    outcome: action.implementationResult.outcome,
    presentation: implementationPresentation(action.implementationResult),
  };
}
