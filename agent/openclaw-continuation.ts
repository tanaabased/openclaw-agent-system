import { nativeInputEvent } from './openclaw-session-input.ts';
import issueWorkflowProgress from './issue-workflow-progress.ts';
import { feedbackWorkStarted } from './feedback-work.ts';
import { validateChatSendParams } from '@openclaw/gateway-protocol';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { automationHash } from './automation-hash.ts';
import issueProgression from './issue-progression.ts';
import { feedbackSession } from './openclaw-feedback.ts';
import { reconcileOpenClawTurn } from './openclaw-turn.ts';
import { describeIssueSession, sessionObject } from './openclaw-session-create.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

type Mode = 'plan' | 'work' | 'auto';
/** select a continuation without reviving stopped work or replaying a submitted turn. */
export function openClawWorkSlot(record: OpenClawDispatchRecord, mode: Mode) {
  if (
    record.feedbackReactivation ||
    (!record.work?.turn && record.decisionTurn && record.decisionTurn.status !== 'completed') ||
    !record.sessionCreation?.verified ||
    (!record.work?.turn && record.assessmentTurn?.status !== 'completed')
  )
    return;
  const work = record.work;
  const progress = issueWorkflowProgress(record);
  if (progress.action === 'stopped') return;
  if (work?.turn && work.turn.status !== 'completed') return 'turn' as const;
  if (work?.deliveryTurn && work.deliveryTurn.status !== 'completed')
    return 'deliveryTurn' as const;
  if (feedbackWorkStarted(record)) return;
  if (progress.action === 'delivery') return 'deliveryTurn' as const;
  if (
    progress.action === 'implementation' &&
    (work?.turn?.status === 'completed' || (!work?.turn && work?.implementation))
  )
    return 'turn' as const;
  if (
    ['assessment', 'implementation'].includes(progress.action) &&
    !work &&
    !record.handoff &&
    issueProgression(record, { mode, now: 0 }).status === 'ready'
  )
    return 'turn' as const;
}

/** send once into the existing idle owner, then reconcile its exact native receipt. */
export default async function advanceOpenClawWork(input: {
  record: OpenClawDispatchRecord;
  mode: Mode;
  reconcileOnly?: boolean;
  selection?: NonNullable<OpenClawDispatchRecord['work']>['selection'];
  now: number;
  request: DispatchRequest;
  config: OpenClawConfig;
  save(): Promise<void>;
  assertCurrent(): Promise<void>;
}) {
  const { record, request, save } = input;
  const expected = record.request;
  if (!expected || !('key' in expected)) return { status: 'implementation-idle', id: record.id };
  // A same-turn handoff ends decision scheduling, not custody of its native turn.
  if (
    record.handoff &&
    record.decisionTurn &&
    record.decisionTurn.status !== 'completed' &&
    !record.decisionTurn.inactive
  ) {
    await describeIssueSession(request, record, input.config);
    await reconcileOpenClawTurn({
      request,
      sessionKey: expected.key,
      sessionId: record.sessionCreation!.sessionId!,
      model: expected.model,
      turn: record.decisionTurn,
      save,
    });
  }
  const slot = openClawWorkSlot(record, input.mode);
  if (!slot) return { status: 'implementation-idle', id: record.id };
  // Older direct handoffs retained custody without a coordinator turn. Adopt it before any send.
  if (slot === 'turn' && !record.work?.turn && record.work?.implementation) {
    const source = record.work.implementation;
    const native = await nativeInputEvent({
      request,
      sessionKey: expected.key,
      sessionId: record.sessionCreation!.sessionId!,
      runId: source.runId,
      retained: [source],
    });
    record.work.turn = {
      origin: 'input',
      runId: native.runId,
      message: native.message,
      status: 'consumed',
      consumedByEventId: native.inputEventId,
    };
    await save();
  }
  if (input.reconcileOnly && (!record.work?.[slot] || record.work[slot]!.status === 'completed'))
    return { status: 'implementation-idle', id: record.id };
  if (!record.work?.[slot] || record.work[slot]!.status === 'completed') {
    const session = await feedbackSession(request, record, input.config);
    if (session.busy) return { status: 'implementation-queued', id: record.id };
    if (typeof session.leaf !== 'string' || !session.leaf)
      throw new Error('dispatch-work-session-unverified');
    const transition = issueProgression(record, { mode: input.mode, now: input.now });
    if (transition.status !== 'ready')
      return { status: 'policy-held', id: record.id, reason: transition.reason };
    const previous = record.work?.[slot];
    if (previous) {
      record.work!.previousTurns = [
        ...(record.work!.previousTurns ?? []),
        { slot, turn: previous },
      ];
      delete record.work![slot];
    }
    const resumed = record.work?.previousTurns?.filter((entry) => entry.slot === slot).length ?? 0;
    const runId = `${record.id}:${slot === 'turn' ? 'implementation' : 'delivery'}${resumed ? ':resume:' + resumed : ''}`;
    const message = [
      slot === 'turn'
        ? 'Continue this issue through implementation and managed PR delivery.'
        : 'Resume only managed PR delivery; implementation is already recorded. Do not repeat implementation.',
      `Call agent_system_dispatch action implementation-context with id ${record.id}. Follow only verified context in this existing issue chat and worktree.`,
      'Reuse retained results, commits and partial work. Complete only the unfinished step; never replay completed implementation or create a replacement PR.',
      'Reconcile the latest conversation and retained work first. Honor current user restrictions, cancellation and native denial. Work is already authorized; do not ask for routine stage approval. Keep the selected model and effort.',
      'After implementation submit implementation-result with done, blocked, or clarification-needed and its questions. Show clarification questions in this chat and wait for an answer. For done, use delivery prepare and publish with the returned digest, then compose, candidate, announce, and present. Preserve uncertain operations and use their existing receipts; never recreate a PR or resend a continuation.',
    ].join('\n\n');
    const params = {
      sessionKey: expected.key,
      agentId: expected.agentId,
      sessionId: record.sessionCreation!.sessionId!,
      message,
      queueMode: 'followup',
      deliver: false,
      expectedLeafEntryId: session.leaf,
      idempotencyKey: runId,
    };
    if (!validateChatSendParams(params)) throw new Error('dispatch-turn-request-invalid');
    await input.assertCurrent();
    record.progression = transition.progression;
    record.handoff ??= { at: input.now, by: record.sourceThreadId, turnId: runId };
    record.work ??= { assessmentDigest: automationHash(record.result) };
    record.work.selection ??= input.selection;
    delete record.work.code;
    record.work[slot] = { runId, message, status: 'attempted' };
    await save();
    await input.assertCurrent();
    const sent = sessionObject(await request('chat.send', params));
    if (sent.runId !== runId || !['started', 'queued', 'ok'].includes(String(sent.status)))
      throw new Error('dispatch-turn-send-unverified');
    record.work[slot]!.status = 'accepted';
    await save();
  }
  await describeIssueSession(request, record, input.config);
  const turn = record.work![slot]!;
  await reconcileOpenClawTurn({
    request,
    sessionKey: expected.key,
    sessionId: record.sessionCreation!.sessionId!,
    model: expected.model,
    turn,
    save,
  });
  if (turn.status === 'completed') {
    if (
      ['implementation-result-missing', 'implementation-delivery-incomplete'].includes(
        record.work!.code ?? '',
      )
    )
      delete record.work!.code;
    if (slot === 'turn' && !record.work!.result)
      record.work!.code = 'implementation-result-missing';
    if (slot === 'deliveryTurn' && issueWorkflowProgress(record).action === 'delivery')
      record.work!.code = 'implementation-delivery-incomplete';
    await save();
  }
  return {
    status: record.work!.code
      ? 'implementation-incomplete'
      : turn.status === 'completed'
        ? 'implementation-completed'
        : 'implementation-pending',
    ...(record.work!.code ? { nextAction: 'next' as const } : {}),
    id: record.id,
    code: record.work!.code,
  };
}
