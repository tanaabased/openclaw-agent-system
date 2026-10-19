import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { Static } from 'typebox';

import { automationHash } from './automation-hash.ts';
import issueProgression from './issue-progression.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { operatorInputEvent } from './openclaw-session-input.ts';
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
export async function verifyOpenClawOperator(input: {
  record: OpenClawDispatchRecord;
  caller: DispatchCaller;
  operator: boolean;
  request: DispatchRequest;
  config: OpenClawConfig;
}) {
  const { record, caller } = input;
  if (
    record.feedback?.events.some((event) => event.turn?.runId === caller.runId) ||
    !input.operator ||
    caller.sessionKey !== record.threadId ||
    caller.sessionId !== record.sessionCreation?.sessionId ||
    caller.runId === record.firstTurn?.runId ||
    caller.runId === record.assessmentTurn?.runId ||
    !record.result ||
    !record.stageReceipt ||
    record.result.outcome !== 'plan-ready'
  )
    throw new Error('dispatch-operator-followup-required');
  await describeIssueSession(input.request, record, input.config);
  return operatorInputEvent({
    request: input.request,
    senderIsOwner: input.operator,
    sessionKey: caller.sessionKey,
    sessionId: caller.sessionId,
    runId: caller.runId,
    retained: [
      record.work?.operatorInput,
      record.work?.caller,
      record.work?.implementation,
      record.work?.publication,
    ],
  });
}

export default async function openClawWorkAction(input: {
  record: OpenClawDispatchRecord;
  caller: DispatchCaller;
  source: { runId: string; inputEventId: string };
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
          'Apply only the permission explicitly requested by this operator in this issue chat. The existence of an owner turn does not establish what was requested. Implementation permission does not authorize publication. Apply the digest to retain this exact handoff.',
      };
    if (action.digest !== digest) throw new Error('dispatch-handoff-stale');
    record.work ??= { assessmentDigest };
    if (action.permission !== 'publication') {
      const transition = issueProgression(record, { mode: 'plan', operator: true, now: input.now });
      if (transition.status !== 'ready') throw new Error(transition.reason);
      record.progression = transition.progression;
      record.work.implementation = source;
    }
    if (action.permission !== 'implementation') record.work.publication = source;
    record.handoff ??= { at: input.now, by: input.caller.sessionKey, turnId: source.runId };
    await input.save();
    return {
      status: 'handed-off',
      id: record.id,
      instructions:
        'Call implementation-context before changing files, or delivery prepare for already implemented work. Preserve the complete assessment, worktree, and selected model/effort. Only the explicitly requested scope is authorized.',
    };
  }
  if (!record.work?.implementation)
    throw new Error('dispatch-implementation-authorization-required');
  if (action.action === 'implementation-context') {
    record.work.caller = source;
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
      previousImplementationResult: record.work.result,
      publicationAuthorized: Boolean(record.work.publication),
      instructions:
        'Use agent-system-issue-implementation with this complete assessment in the existing worktree. Preserve routing and prior work. Follow the operator request; stop on cancellation or denial. Commit validated work and retain the complete outcome with implementation-result. A done result does not authorize publication: delivery requires the separately retained operator publication request. Do not use Codex runtime commands.',
    };
  }
  if (!record.work.caller || automationHash(record.work.caller) !== automationHash(source))
    throw new Error('dispatch-implementation-context-required');
  record.work.result = action.implementationResult;
  await input.save();
  return {
    status: 'recorded',
    id: record.id,
    outcome: action.implementationResult.outcome,
    presentation: action.implementationResult.fullResult,
  };
}
