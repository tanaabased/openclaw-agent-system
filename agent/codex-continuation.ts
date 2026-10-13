import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { automationHash } from './automation-hash.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import codexContinuationNative from './codex-continuation-native.ts';
import { implementationResultSchema } from './codex-continuation-state.ts';
import runCodexDelivery, { type CodexDeliveryDependencies } from './codex-delivery.ts';
import { revalidateDispatchAssignment, type CodexDispatchDependencies } from './codex-dispatch.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import { dispatchGit, verifyDispatchWorktree } from './codex-dispatch-project.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import codexHostAccess from './codex-host-access.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { requireWorkflowSchedule, validateWorkflowResult } from './workflow-result.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
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
    ]),
    id: Type.Optional(Type.String()),
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
  if (!caller) throw new Error('continuation-caller-required');
  const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
    pluginData,
    { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
    false,
    false,
    input.action === 'delivery' ? 'publication' : 'implementation',
  );
  const schedule = activation.schedule;
  if (!schedule) throw new Error('workflow-schedule-reconciliation-required');
  requireWorkflowSchedule(
    schedule.saved,
    schedule.current,
    input.action === 'delivery' ? 'publication' : 'implementation',
  );
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
                !record.reset &&
                !['complete', 'blocked', 'cancelled'].includes(record.continuation.phase),
            )
          : state.records.filter((record) => record.id === input.id);
      if (!candidates.length && input.action !== 'next')
        throw new Error('continuation-record-missing');
      for (const record of candidates) {
        try {
          const work = record.continuation;
          if (
            !work ||
            !record.threadId ||
            !record.worktree ||
            !record.project ||
            !record.request ||
            record.handoff ||
            record.retired ||
            record.reset
          )
            throw new Error('continuation-managed-issue-required');
          if (!occurrence && caller !== record.threadId)
            throw new Error('continuation-issue-caller-required');
          if (
            record.sourceThreadId !== activation.sourceThreadId ||
            work.policyDigest !== schedule.current.policyDigest ||
            current.manifest.github?.notifications?.schemaVersion !== 2 ||
            current.manifest.github.notifications.issueAssignment?.mode !== 'work'
          )
            throw new Error('continuation-authority-changed');
          if (['blocked', 'cancelled', 'complete'].includes(work.phase))
            return { status: work.phase, id: record.id, code: work.code };
          if (!record.result) continue;
          if (record.result.outcome !== 'plan-ready') {
            work.phase = 'blocked';
            work.code = 'continuation-assessment-not-actionable';
            await save();
            continue;
          }
          if (work.assessmentDigest && work.assessmentDigest !== automationHash(record.result))
            throw new Error('continuation-assessment-changed');
          const admitted = (await current.store.read())?.records.find(
            (entry) => entry.id === record.intakeId,
          );
          if (!admitted) throw new Error('continuation-admission-missing');
          await revalidateDispatchAssignment(current, admitted, deps, signal, false);
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
            configuration: current.manifest.github.notifications.issueAssignment.implementation,
            workspace: current.workspace,
            observedAt: work.selection.observedAt,
            resolveSkill: (id) => native.assessmentSkill(found.cwd, id),
          });
          const expectedSkill = work.selection.skill,
            actualSkill = selection.selection.skill;
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
            automationHash(work.selection.guidance ?? null) !==
              automationHash(selection.selection.guidance ?? null)
          )
            throw new Error('continuation-selection-changed');
          // recheck the saved native activation after provider and skill reads, before side effects.
          const fresh = await (deps.activation ?? inspectCodexDispatchActivation)(
            pluginData,
            { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
            false,
            false,
            input.action === 'delivery' ? 'publication' : 'implementation',
          );
          if (automationHash(fresh.schedule) !== automationHash(schedule))
            throw new Error('continuation-authority-changed');
          if (!work.attempt) {
            if (
              input.action !== 'next' ||
              !occurrence ||
              found.turnStatus !== 'completed' ||
              !['idle', 'notLoaded'].includes(found.status)
            )
              continue;
            if (found.turnId !== record.resultTurnId)
              throw new Error('continuation-user-intervened');
            work.assessmentDigest = automationHash(record.result);
            const id = automationHash({
              id: record.id,
              assessment: work.assessmentDigest,
              selection: work.selection,
              before: found.turnId,
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
                  'Continue this managed Work-mode issue through implementation and pull-request delivery. Work mode already authorizes this sequence; do not request routine stage approval. Before editing, call continuationRuntime from the newest trusted Agent System context with JSON on stdin: ' +
                  JSON.stringify({ action: 'context', id: record.id }) +
                  '. Proceed only after verified context; follow its retained assessment, implementation selection, and instructions. Stop on substantive blockers or native denial. Continuation receipt: ' +
                  id +
                  '.',
              },
            };
            work.phase = 'prepared';
            await save();
            return { status: 'prepared', id: record.id, request: work.attempt.request };
          }
          const activeAttempt = work.publicationAttempt ?? work.attempt;
          const receipt = await continuationNative(record.sourceThreadId, activeAttempt);
          if (receipt.status === 'blocked') {
            work.phase = 'blocked';
            work.code = receipt.code;
            await save();
            return { status: 'blocked', id: record.id, code: work.code };
          }
          if (receipt.status !== 'verified') {
            if (!occurrence) throw new Error('continuation-send-unverified');
            continue;
          }
          if (activeAttempt.turnId && activeAttempt.turnId !== receipt.turnId)
            throw new Error('continuation-turn-changed');
          activeAttempt.turnId = receipt.turnId;
          if (found.turnId !== receipt.turnId) throw new Error('continuation-user-intervened');
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
              assessment: record.result,
              implementation: selection.selection,
              binding: work.binding,
              resultContract: 'implementation-result/v1',
              resultSchema: implementationResultSchema,
              previousResult: work.result,
              deliveryOnly: Boolean(work.result?.outcome === 'done'),
              instructions:
                'Work mode authorizes implementation and PR publication without further stage approval while this context remains valid. If previousResult is done, resume only delivery and never repeat implementation. Otherwise invoke the selected implementation skill and retained guidance with the complete assessment, existing files, and repository instructions. Resolve ordinary implementation choices autonomously; stop for consequential missing requirements or actual native denial. Preserve the selected model/effort. Use a task branch, implement, run the required checks, and commit the finished work. Do not bypass denied commands. Retain complete substantive output, including validation and limitations, in fullResult. Submit continuationRuntime action:result with this id and result {outcome:done|blocked,summary,fullResult}. Only a recorded done result permits continuationRuntime action:delivery with nested delivery {action:prepare|publish|reconcile|present,...}; reuse the managed operation and returned digest, never create a replacement PR. Use native attach_artifact and reproduce the complete returned presentation. On resume refresh this context; reconcile existing files and delivery instead of replaying implementation. Do not use manual assessment handoff for this automatic continuation.',
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
            ['completed', 'failed', 'interrupted'].includes(receipt.turnStatus) &&
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
                  'Resume only the managed PR delivery for this Work-mode issue; implementation is already recorded. Do not repeat implementation or ask for stage approval. Refresh continuationRuntime context using JSON on stdin: ' +
                  JSON.stringify({ action: 'context', id: record.id }) +
                  '. Reconcile the retained delivery operation; never create a replacement PR. Stop on actual native denial.',
              },
            };
            await save();
            return { status: 'prepared', id: record.id, request: work.publicationAttempt.request };
          }
          if (
            occurrence &&
            ['completed', 'failed', 'interrupted'].includes(receipt.turnStatus) &&
            work.phase !== 'complete'
          ) {
            work.phase = 'blocked';
            work.code = 'continuation-turn-ended';
            await save();
          }
        } catch (error) {
          if (codexHostAccess(error) || (input.action !== 'next' && input.action !== 'reconcile'))
            throw error;
          if (record.continuation) {
            record.continuation.phase = 'blocked';
            record.continuation.code =
              error instanceof Error && /^[a-z][a-z0-9-]{0,127}$/u.test(error.message)
                ? error.message
                : 'continuation-host-unavailable';
            await save();
          }
          return { status: 'blocked', id: record.id, code: record.continuation?.code };
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
          const fresh = await (deps.activation ?? inspectCodexDispatchActivation)(
            pluginData,
            { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
            false,
            false,
            'publication',
          );
          if (automationHash(fresh.schedule) !== automationHash(schedule))
            throw new Error('continuation-authority-changed');
        },
      },
    );
    if ('action' in input.delivery && input.delivery.action === 'present')
      await store.exclusive(async (state, save) => {
        const record = state.records.find((entry) => entry.id === input.id);
        if (record?.continuation?.phase === 'delivery' && record.delivery?.reconciled) {
          record.continuation.phase = 'complete';
          await save();
        }
      }, true);
    return delivery;
  } finally {
    await connection?.close();
  }
}
