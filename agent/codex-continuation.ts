import liveWorkflowPolicy, { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { notificationAuthorityDigest } from './notification-authority.ts';
import workflowFailure from './workflow-failure.ts';
import { dispatchFailurePhase, dispatchRetryDue, scheduleDispatchRetry } from './dispatch-retry.ts';
import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { automationHash } from './automation-hash.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import codexContinuationNative from './codex-continuation-native.ts';
import { implementationResultSchema } from './implementation-result.ts';
import runCodexDelivery, { type CodexDeliveryDependencies } from './codex-delivery.ts';
import { revalidateDispatchAssignment, type CodexDispatchDependencies } from './codex-dispatch.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import { dispatchGit, verifyDispatchWorktree } from './codex-dispatch-project.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import codexHostAccess from './codex-host-access.ts';
import dispatchContext, { dispatchEvidence } from './dispatch-context.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { requireWorkflowSchedule, validateWorkflowResult } from './workflow-result.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import issueProgression, { retainedIssueProgression } from './issue-progression.ts';
import isPathContained from '../utils/is-path-contained.ts';

const requestSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal('next'),
      Type.Literal('reconcile'),
      Type.Literal('context'),
      Type.Literal('result'),
      Type.Literal('cancel'),
      Type.Literal('delivery'),
      Type.Literal('retry'),
      Type.Literal('retry-denied'),
    ]),
    id: Type.Optional(Type.String()),
    digest: Type.Optional(Type.String()),
    approvedCallId: Type.Optional(Type.String()),
    result: Type.Optional(implementationResultSchema),
    delivery: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);
export interface CodexContinuationDependencies extends CodexDispatchDependencies {
  continuationNative?: ReturnType<typeof codexContinuationNative>;
  deliver?: typeof runCodexDelivery;
  deliveryDependencies?: CodexDeliveryDependencies;
}

/** work mode is standing authority; these checks never ask for another stage approval. */
export default async function runCodexContinuation(
  pluginData: string,
  input: unknown,
  deps: CodexContinuationDependencies = {},
) {
  if (!Value.Check(requestSchema, input) || (input.action !== 'next' && !input.id))
    throw new Error('continuation-request-invalid');
  const current = await selectCodexIntake(pluginData, deps);
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  const retryDenied = input.action === 'retry-denied';
  const retry = input.action === 'retry' || retryDenied;
  if (!caller) throw new Error('continuation-caller-required');
  const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
    pluginData,
    { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
    false,
    true,
    input.action === 'delivery' ? 'publication' : 'implementation',
  );
  const schedule = activation.schedule;
  if (!schedule) throw new Error('workflow-schedule-reconciliation-required');
  requireWorkflowSchedule(
    schedule.saved,
    schedule.current,
    input.action === 'delivery' ? 'publication' : 'implementation',
  );
  if (retry && caller === activation.sourceThreadId)
    throw new Error('continuation-operator-caller-required');
  if (input.action === 'next' || input.action === 'reconcile') {
    if (caller !== activation.sourceThreadId)
      throw new Error('continuation-schedule-caller-required');
  }
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const connection =
    deps.native && deps.continuationNative
      ? undefined
      : await connectCodexThreads(current.workspace, current.codexHome);
  const native = deps.native ?? codexDispatchNative(connection!.request);
  const continuationNative =
    deps.continuationNative ?? codexContinuationNative(connection!.request);
  const git = deps.git ?? dispatchGit;
  try {
    const response = await store.exclusive(async (state, save, signal) => {
      if (
        retry &&
        state.records.some(
          (record) =>
            !record.handoff && (record.threadId === caller || record.receiptThreadId === caller),
        )
      )
        throw new Error('continuation-operator-caller-required');
      const occurrence =
        input.action === 'next' || input.action === 'reconcile'
          ? await native.occurrence(caller)
          : undefined;
      if (occurrence && occurrence.automationId !== schedule.current.automationId)
        throw new Error('continuation-occurrence-mismatch');
      if (occurrence) {
        if (state.continuationRun?.id !== occurrence.id)
          state.continuationRun = { id: occurrence.id, actions: 0 };
        if (state.continuationRun.actions >= 12) return { status: 'budget-exhausted' };
        state.continuationRun.actions++;
        await save();
      }
      const admissions = await current.store.read();
      const liveMode = current.manifest.github?.notifications?.issueAssignment?.mode;
      if (input.action === 'next' && (liveMode === 'work' || liveMode === 'auto'))
        for (const record of state.records) {
          const admitted = admissions?.records.find((entry) => entry.id === record.intakeId);
          if (
            record.continuation ||
            record.result?.outcome !== 'plan-ready' ||
            !record.project ||
            !record.worktree ||
            !record.request ||
            record.handoff ||
            record.retired ||
            record.retirement ||
            record.reset ||
            !admitted ||
            liveWorkflowPolicy(current.manifest, 'codex', admitted, 'implementation')
          )
            continue;
          const selected = await selectWorkflowStage({
            stage: 'implementation',
            configuration: current.manifest.github!.notifications!.issueAssignment!.implementation,
            workspace: current.workspace,
            observedAt: (deps.now ?? Date.now)(),
            resolveSkill: (id) => native.assessmentSkill(record.worktree!, id),
          });
          record.continuation = {
            phase: 'waiting',
            selection: selected.selection,
            policyDigest: notificationAuthorityDigest(current.manifest.github?.notifications),
          };
          await save();
        }
      const candidates =
        input.action === 'next'
          ? state.records.filter(
              (record) =>
                record.continuation &&
                record.result &&
                record.threadId &&
                record.worktree &&
                !record.handoff &&
                !record.retired &&
                !record.retirement &&
                !record.feedbackReactivation &&
                !record.reset &&
                (!['complete', 'blocked', 'cancelled'].includes(record.continuation.phase) ||
                  ['continuation-auto-wait', 'continuation-assessment-not-actionable'].includes(
                    record.continuation.code ?? '',
                  )),
            )
          : state.records.filter((record) => record.id === input.id);
      if (!candidates.length && input.action !== 'next')
        throw new Error('continuation-record-missing');
      for (const record of candidates) {
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
          if (
            !work ||
            !record.threadId ||
            !record.worktree ||
            !record.project ||
            !record.request ||
            record.handoff ||
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
            continue;
          if (!occurrence && !retry && caller !== record.threadId)
            throw new Error('continuation-issue-caller-required');
          if (record.sourceThreadId !== activation.sourceThreadId)
            throw new Error('continuation-schedule-binding-mismatch');
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
              record.delivery ||
              (work.retries?.length ?? 0) >= 8)
          )
            throw new Error('continuation-retry-unavailable');
          if (!retry && ['blocked', 'cancelled', 'complete'].includes(work.phase)) {
            if (input.action === 'next') continue;
            return { status: work.phase, id: record.id, code: work.code };
          }
          if (!record.result) continue;
          const admitted = admissions?.records.find((entry) => entry.id === record.intakeId);
          if (!admitted) throw new Error('continuation-admission-missing');
          const enteringImplementation = !retainedIssueProgression(record);
          const authorizeLive = async () => {
            const live = await selectCodexIntake(pluginData, deps);
            const held = liveWorkflowPolicy(
              live.manifest,
              'codex',
              admitted,
              enteringImplementation ? 'implementation' : 'assignment',
            );
            if (held) throw new WorkflowPolicyHeld(held);
            if (
              enteringImplementation &&
              live.manifest.github?.notifications?.issueAssignment?.mode !== liveMode
            )
              throw new WorkflowPolicyHeld('workflow-mode-updated');
            return live;
          };
          if (!['reconcile', 'cancel', 'result'].includes(input.action)) await authorizeLive();
          if (
            !work.attempt &&
            !work.binding &&
            (input.action === 'next' || input.action === 'context')
          ) {
            const live = await authorizeLive();
            const selected = await selectWorkflowStage({
              stage: 'implementation',
              configuration: live.manifest.github!.notifications!.issueAssignment!.implementation,
              workspace: current.workspace,
              observedAt: work.selection.observedAt,
              resolveSkill: (id) => native.assessmentSkill(record.worktree!, id),
            });
            work.selection = selected.selection;
          }
          delete work.policyHeld;
          if (enteringImplementation && liveMode === 'auto') {
            if (!record.result.decision) throw new WorkflowPolicyHeld('auto-decision-required');
            if (
              !record.stageReceipt ||
              record.stageReceipt.resultDigest !== automationHash(record.result) ||
              record.stageReceipt.binding.selectionDigest !== automationHash(record.assessment) ||
              record.stageReceipt.binding.routingDigest !==
                automationHash({ routing: record.routing, effective: record.effective }) ||
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
            mode: liveMode ?? 'plan',
            now: (deps.now ?? Date.now)(),
          });
          if (
            !['reconcile', 'cancel', 'result'].includes(input.action) &&
            transition.status !== 'ready'
          )
            throw new WorkflowPolicyHeld(transition.reason);
          if (work.assessmentDigest && work.assessmentDigest !== automationHash(record.result))
            throw new Error('continuation-assessment-changed');
          const { client, repo } = await revalidateDispatchAssignment(
            current,
            admitted,
            deps,
            signal,
            true,
          );
          if (enteringImplementation && liveMode === 'auto' && !work.binding) {
            const retained = JSON.parse(record.context!);
            const latest = dispatchContext(
              await client.getItemContext(
                repo.owner.login,
                repo.name,
                admitted.issue.number,
                'issue',
                true,
              ),
              retained.source,
              retained.observedAt,
            );
            if (latest.truncated || retained.truncated)
              throw new Error('continuation-assessment-evidence-incomplete');
            const ownCommentUrls = new Set(
              (record.assessmentSummaries ?? []).flatMap((summary) =>
                summary.receipt
                  ? [`${retained.source}#issuecomment-${summary.receipt.databaseId}`]
                  : [],
              ),
            );
            if (
              automationHash(dispatchEvidence(latest, ownCommentUrls)) !==
              automationHash(dispatchEvidence(retained, ownCommentUrls))
            )
              throw new Error('continuation-assessment-evidence-changed');
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
            (await realpath(found.cwd)) !== (await realpath(record.worktree)) ||
            found.model !== record.request.model ||
            found.effort !== record.request.thinking
          )
            throw new Error('continuation-native-binding-mismatch');
          await verifyDispatchWorktree(
            record.project,
            found.cwd,
            admitted.repository.owner.login + '/' + admitted.repository.name,
            git,
            work.attempt ? 'handoff' : undefined,
          );
          if (input.action === 'cancel') {
            work.phase = 'cancelled';
            await save();
            return { status: 'cancelled', id: record.id };
          }
          const selection = await selectWorkflowStage({
            stage: 'implementation',
            configuration: {
              skill: work.selection.requestedSkill,
              guidance: work.selection.guidance?.content,
            },
            workspace: current.workspace,
            observedAt: work.selection.observedAt,
            resolveSkill: (id) => native.assessmentSkill(found.cwd, id),
          });
          selection.selection = { ...work.selection, skill: selection.selection.skill };
          const selections = [{ expected: work.selection, actual: selection.selection }];
          if (enteringImplementation && liveMode === 'auto') {
            const assessment = await selectWorkflowStage({
              stage: 'assessment',
              configuration: {
                skill: record.assessment!.requestedSkill,
                guidance: record.assessment!.guidance?.content,
              },
              workspace: current.workspace,
              observedAt: record.assessment!.observedAt,
              resolveSkill: (id) => native.assessmentSkill(found.cwd, id),
            });
            selections.push({ expected: record.assessment!, actual: assessment.selection });
          }
          for (const { expected, actual } of selections) {
            const expectedSkill = expected.skill,
              actualSkill = actual.skill;
            const samePath =
              expectedSkill.path === actualSkill.path ||
              (expectedSkill.scope === 'repo' &&
                actualSkill.scope === 'repo' &&
                isPathContained(record.project.path, expectedSkill.path) &&
                isPathContained(found.cwd, actualSkill.path) &&
                relative(record.project.path, expectedSkill.path) ===
                  relative(found.cwd, actualSkill.path));
            if (
              !samePath ||
              expectedSkill.name !== actualSkill.name ||
              expectedSkill.scope !== actualSkill.scope ||
              expectedSkill.digest !== actualSkill.digest ||
              expected.guidance?.content !== actual.guidance?.content
            )
              throw new Error('continuation-selection-changed');
          }
          // recheck the saved native activation after provider and skill reads, before side effects.
          const fresh = await (deps.activation ?? inspectCodexDispatchActivation)(
            pluginData,
            { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
            false,
            true,
            input.action === 'delivery' ? 'publication' : 'implementation',
          );
          if (fresh.sourceThreadId !== activation.sourceThreadId)
            throw new Error('continuation-schedule-binding-mismatch');
          if (input.action !== 'reconcile' && input.action !== 'result') await authorizeLive();
          if (!work.attempt) {
            if (
              input.action !== 'next' ||
              !occurrence ||
              (work.retries?.length
                ? !['completed', 'failed', 'interrupted'].includes(found.turnStatus ?? '')
                : found.turnStatus !== 'completed') ||
              !['idle', 'notLoaded'].includes(found.status)
            )
              continue;
            if (transition.status !== 'ready') throw new WorkflowPolicyHeld(transition.reason);
            record.progression = transition.progression;
            work.assessmentDigest = automationHash(record.result);
            if (liveMode === 'auto')
              work.assessmentSelectionDigest = automationHash(record.assessment);
            const id = automationHash({
              id: record.id,
              assessment: work.assessmentDigest,
              selection: work.selection,
              before: found.turnId,
              ...(work.retries?.length ? { retry: work.retries.length } : {}),
            });
            work.attempt = {
              id,
              sourceTurnId: occurrence.id,
              beforeTurnId: found.turnId,
              request: {
                threadId: record.threadId,
                model: record.request.model,
                thinking: record.request.thinking,
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
            return { status: 'prepared', id: record.id, request: work.attempt.request };
          }
          const activeAttempt = work.publicationAttempt ?? work.attempt;
          const receipt = await continuationNative(record.sourceThreadId, activeAttempt);
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
              record.project,
              found.cwd,
              admitted.repository.owner.login + '/' + admitted.repository.name,
              git,
            );
            const digest = automationHash({ record, schedule: schedule.current, receipt });
            if (input.digest === undefined)
              return {
                status: 'retry-available',
                id: record.id,
                digest,
                threadId: record.threadId,
                rejection: receipt.rejection,
                instruction:
                  'Only explicit operator reapproval of this rejected call authorizes retry-denied with this digest and approvedCallId. Preserve the rejected attempt and queue one new handoff for scheduled intake; native approval still applies.',
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
            return { status: 'retry-ready', id: record.id, threadId: record.threadId };
          }
          if (retry && work.phase === 'prepared' && receipt.status !== 'mismatch')
            throw new Error('continuation-retry-unavailable');
          if (receipt.status === 'blocked' || (receipt.status === 'mismatch' && !retry)) {
            work.phase = 'blocked';
            work.code = receipt.code;
            await save();
            return { status: 'blocked', id: record.id, code: work.code };
          }
          if (retry && receipt.status === 'mismatch') {
            if (work.binding || work.result || work.publicationAttempt || record.delivery)
              throw new Error('continuation-retry-unavailable');
            await verifyDispatchWorktree(
              record.project,
              found.cwd,
              admitted.repository.owner.login + '/' + admitted.repository.name,
              git,
            );
          }
          if (receipt.status !== 'verified' && !(retry && receipt.status === 'mismatch')) {
            if (!occurrence) throw new Error('continuation-send-unverified');
            return { status: 'pending', id: record.id, code: 'continuation-send-unverified' };
          }
          if (activeAttempt.turnId && activeAttempt.turnId !== receipt.turnId)
            throw new Error('continuation-turn-changed');
          if (
            found.turnId !==
              (receipt.status === 'mismatch' ? receipt.latestTurnId : receipt.turnId) &&
            found.turnId !== work.activeTurnId
          ) {
            if (retry) throw new Error('continuation-retry-context-changed');
            if (
              input.action === 'context' &&
              caller === record.threadId &&
              found.followUpUserTurn
            ) {
              work.activeTurnId = found.turnId;
            } else
              return {
                status: 'pending',
                id: record.id,
                code: 'continuation-conversation-advanced',
                instructions:
                  'The issue conversation has advanced. Reconcile current work in that chat through continuation context; do not resend the implementation request or overwrite newer user direction.',
              };
          }
          if (retry) {
            if (!receipt.ended || !['idle', 'notLoaded'].includes(found.status))
              throw new Error('continuation-retry-chat-active');
            const digest = automationHash({
              record,
              schedule: schedule.current,
              turnId: receipt.turnId,
              ...(receipt.status === 'mismatch'
                ? { receipt, resumeAfterTurnId: found.turnId }
                : {}),
            });
            if (input.digest === undefined)
              return {
                status: 'retry-available',
                id: record.id,
                digest,
                threadId: record.threadId,
                instruction:
                  'Retain the plan, chat, worktree, and previous attempt. Queue one new implementation handoff for the next scheduled occurrence; do not send it manually.',
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
            return { status: 'retry-ready', id: record.id, threadId: record.threadId };
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
            threadId: record.threadId,
            turnId: receipt.turnId,
            worktree: found.cwd,
            dispatchDigest: automationHash(work.attempt),
            policyDigest: work.policyDigest,
            selectionDigest: automationHash(work.selection),
            routingDigest: automationHash(record.request),
            evidenceDigest: work.assessmentDigest!,
          };
          await save();
          if (input.action === 'context')
            return {
              status: 'verified',
              id: record.id,
              issueStage: record.progression?.stage ?? 'planning',
              assessment: record.result,
              assessmentSelection: record.assessment,
              implementation: selection.selection,
              binding: work.binding,
              resultContract: 'implementation-result/v1',
              resultSchema: implementationResultSchema,
              previousResult: work.result,
              deliveryOnly: Boolean(work.result?.outcome === 'done'),
              instructions:
                'The verified installed workflow authorizes implementation and PR publication without further stage approval while this context remains valid. Auto requires its verified Work decision when entering implementation; later mode edits preserve the recorded stage. If previousResult is done, resume only delivery and never repeat implementation. Otherwise invoke the selected implementation skill and retained guidance with the complete assessment, its assessmentSelection, existing files, and repository instructions. Resolve ordinary implementation choices autonomously; stop for consequential missing requirements or actual native denial. Preserve the selected model/effort. Use a task branch, implement, run the required checks, and commit the finished work. Do not bypass denied commands. Retain complete substantive output, including validation and limitations, in fullResult. Submit continuationRuntime action:result with this id and result {outcome:done|blocked,summary,fullResult}. Only a recorded done result permits continuationRuntime action:delivery with nested delivery {action:prepare|publish|reconcile|compose|candidate|announce|present,...}; reuse the managed operation and returned digest, never create a replacement PR. For new PR delivery, compose a concise public title and body from the verified implementation outcome, validation, and limitations. Include issue-required evidence and a closing reference; do not copy private context or the full private report. Pass title/body to delivery prepare and retain them unchanged with its digest on publish. Use native attach_artifact. After PR linkage use delivery compose, invoke the selected reply skill for the delivery event, submit candidate, and execute announce with its preview digest through native approval. Preserve the delivered PR if the announcement fails. Then present and reproduce the complete private PR card and announcement outcome. On resume refresh this context; reconcile existing files and delivery instead of replaying implementation. Do not use manual assessment handoff for this automatic continuation.',
            };
          if (input.action === 'result') {
            if (work.publicationAttempt)
              throw new Error('continuation-implementation-already-recorded');
            if (!input.result) throw new Error('continuation-result-required');
            validateWorkflowResult(
              {
                version: 1,
                stage: 'implementation',
                resultContract: 'implementation-result/v1',
                binding: work.binding,
                result: { outcome: input.result.outcome, summary: input.result.summary },
              },
              { stage: 'implementation', authorized: true, binding: work.binding },
            );
            if (work.result && automationHash(work.result) !== automationHash(input.result))
              throw new Error('continuation-result-conflict');
            if (input.result.outcome === 'done') {
              if ((await git(found.cwd, ['status', '--porcelain=v1'], signal)).trim())
                throw new Error('continuation-uncommitted-work');
              const head = (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
              if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('continuation-head-invalid');
              work.head = head;
            }
            work.result = input.result;
            work.phase = input.result.outcome === 'done' ? 'delivery' : 'blocked';
            await save();
            return {
              status: 'recorded',
              id: record.id,
              outcome: input.result.outcome,
              next: work.phase,
            };
          }
          if (input.action === 'delivery') {
            if (
              work.phase !== 'delivery' ||
              work.result?.outcome !== 'done' ||
              !work.head ||
              (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim() !== work.head
            )
              throw new Error('continuation-implementation-required');
            return { status: 'deliver', id: record.id };
          }
          if (
            occurrence &&
            work.phase === 'delivery' &&
            work.result?.outcome === 'done' &&
            !work.publicationAttempt &&
            currentTurnEnded &&
            found.turnStatus === 'completed' &&
            ['idle', 'notLoaded'].includes(found.status)
          ) {
            work.publicationAttempt = {
              id: automationHash({
                id: work.attempt.id,
                stage: 'publication',
                result: work.result,
              }),
              sourceTurnId: occurrence.id,
              beforeTurnId: found.turnId,
              request: {
                threadId: record.threadId,
                model: record.request.model,
                thinking: record.request.thinking,
                prompt:
                  'Resume only the managed PR delivery for this issue; implementation is already recorded. Do not repeat implementation or ask for stage approval. Refresh continuationRuntime context using JSON on stdin: ' +
                  JSON.stringify({ action: 'context', id: record.id }) +
                  '. Reconcile the retained delivery operation; never create a replacement PR. Stop on actual native denial.',
              },
            };
            await save();
            return { status: 'prepared', id: record.id, request: work.publicationAttempt.request };
          }
          if (
            occurrence &&
            currentTurnEnded &&
            ['idle', 'notLoaded'].includes(found.status) &&
            work.phase !== 'complete'
          ) {
            work.phase = 'blocked';
            work.code = 'continuation-turn-ended';
            await save();
          }
        } catch (error) {
          if (error instanceof WorkflowPolicyHeld && record.continuation) {
            record.continuation.policyHeld = error.reason;
            await save();
            if (input.action === 'next') continue;
            return { status: 'policy-held', id: record.id, reason: error.reason };
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
            if (
              dispatchFailurePhase(record.continuation, record.continuation.code, error) ===
              'blocked'
            )
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
      return { status: 'idle' };
    }, input.action !== 'next');
    if (response.status !== 'deliver') return response;
    if (
      !input.delivery ||
      typeof input.delivery !== 'object' ||
      Array.isArray(input.delivery) ||
      'id' in input.delivery
    )
      throw new Error('continuation-delivery-invalid');
    const delivery = await (deps.deliver ?? runCodexDelivery)(
      pluginData,
      { ...input.delivery, id: input.id },
      {
        ...deps.deliveryDependencies,
        codexHome: current.codexHome,
        inspectBinding: deps.inspectBinding,
        threadId: caller,
        schedule,
        authorizeSchedule: async () => {
          const live = await selectCodexIntake(pluginData, deps);
          const record = (await store.read()).records.find((entry) => entry.id === input.id);
          const admitted = (await live.store.read())?.records.find(
            (entry) => entry.id === record?.intakeId,
          );
          if (!admitted) throw new Error('continuation-admission-missing');
          const held = liveWorkflowPolicy(
            live.manifest,
            'codex',
            admitted,
            record && retainedIssueProgression(record) ? 'assignment' : 'implementation',
          );
          if (held) throw new WorkflowPolicyHeld(held);
          const fresh = await (deps.activation ?? inspectCodexDispatchActivation)(
            pluginData,
            { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
            false,
            true,
            'publication',
          );
          if (fresh.sourceThreadId !== activation.sourceThreadId)
            throw new Error('continuation-schedule-binding-mismatch');
        },
      },
    );
    if ('action' in input.delivery && input.delivery.action === 'present')
      await store.exclusive(async (state, save) => {
        const record = state.records.find((entry) => entry.id === input.id);
        if (
          record?.continuation?.phase === 'delivery' &&
          record.delivery?.reconciled &&
          record.delivery.announcement?.receipt &&
          !record.delivery.announcement.code
        ) {
          record.continuation.phase = 'complete';
          await save();
        }
      }, true);
    return delivery;
  } finally {
    await connection?.close();
  }
}
