import implementationMaterial from './implementation-material.ts';
import { managedIssueState, dispatchAdmission } from './managed-issue.ts';
import codexCapacity from './codex-capacity.ts';
import { code as responseFailureCode } from './codex-dispatch-context.ts';
import continueCodexResponse from './codex-response-continuation.ts';
import { Value } from 'typebox/value';

import advanceCodexAutoDecision from './codex-auto-decision.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import {
  requestSchema,
  type CodexContinuationDependencies,
  type CodexWorkContext,
} from './codex-continuation-context.ts';
import codexContinuationNative from './codex-continuation-native.ts';
import runCodexDelivery from './codex-delivery.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import { dispatchGit } from './codex-dispatch-project.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import codexLiveTurn from './codex-live-turn.ts';
import advanceCodexWork, { prepareCodexWork } from './codex-work.ts';
import { feedbackWorkStarted } from './feedback-work.ts';
import { retainedIssueProgression } from './issue-progression.ts';
import issueWorkflowProgress from './issue-workflow-progress.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { requireWorkflowSchedule } from './workflow-result.ts';

export type { CodexContinuationDependencies } from './codex-continuation-context.ts';
/** work mode is standing authority; these checks never ask for another stage approval. */
export default async function runCodexContinuation(
  pluginData: string,
  input: unknown,
  deps: CodexContinuationDependencies = {},
) {
  if (
    !Value.Check(requestSchema, input) ||
    (input.action !== 'next' && !input.id) ||
    (input.material !== undefined && input.action !== 'context')
  )
    throw new Error('continuation-request-invalid');
  const current = await selectCodexIntake(pluginData, deps);
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  const retryDenied = input.action === 'retry-denied';
  const retry = input.action === 'retry' || retryDenied;
  if (!caller) throw new Error('continuation-caller-required');
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const manualOwner = (await store.read()).records.find(
    (record) => record.id === input.id && record.manualIssue && record.threadId === caller,
  );
  const activation = manualOwner
    ? { sourceThreadId: manualOwner.sourceThreadId }
    : await (deps.activation ?? inspectCodexDispatchActivation)(
        pluginData,
        { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
        false,
        true,
        input.action === 'delivery' ? 'publication' : 'implementation',
      );
  const schedule = activation.schedule;
  if (!schedule && !manualOwner) throw new Error('workflow-schedule-reconciliation-required');
  if (schedule)
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
      if (occurrence && occurrence.automationId !== schedule?.current.automationId)
        throw new Error('continuation-occurrence-mismatch');
      if (occurrence) {
        await acceptCodexIntakeOccurrence(
          state,
          occurrence,
          () =>
            (deps.activation ?? inspectCodexDispatchActivation)(
              pluginData,
              { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
              false,
              false,
              'intake',
            ),
          save,
        );
        if (state.continuationRun?.id !== occurrence.id)
          state.continuationRun = { id: occurrence.id, actions: 0 };
        if (state.continuationRun.actions >= 12) return { status: 'budget-exhausted' as const };
        state.continuationRun.actions++;
        await save();
      }
      const admissions = managedIssueState(await current.store.read(), state.records);
      const context: CodexWorkContext = {
        records: state.records,
        pluginData,
        input,
        deps,
        current,
        caller,
        activation,
        schedule,
        native,
        continuationNative,
        observeTurn: deps.observeTurn ?? (connection && codexLiveTurn(connection.request)),
        git,
        occurrence,
        admissions,
        save,
        signal,
        ...(deps.directOperator ? { operatorInput: await native.operatorInput(caller) } : {}),
      };
      const decision = context.operatorInput
        ? { response: undefined, decisionPending: undefined }
        : await advanceCodexAutoDecision(state, context);
      if (decision.response) return decision.response;
      const decisionPending = decision.decisionPending;
      if (input.action !== 'next' && decisionPending) return decisionPending;
      if (!input.material) await prepareCodexWork(state, context);
      if (input.action === 'next') {
        for (const record of state.records) {
          if (state.continuationRun?.responses?.includes(record.id)) continue;
          if (
            !record.summaryRecovery &&
            codexCapacity(
              state.records,
              current.policy!.policy.maxConcurrentItems,
              state.projectPickup,
              record.projectWork?.pickup?.issueNodeId,
            ).available === 0
          )
            continue;
          let response;
          try {
            response = await continueCodexResponse(record, context);
          } catch (error) {
            response = {
              status: 'pending' as const,
              id: record.id,
              code: responseFailureCode(error),
              nextAction: 'next',
            };
          }
          if (response) {
            if (state.continuationRun) (state.continuationRun.responses ??= []).push(record.id);
            await save();
            return response;
          }
        }
      }
      const candidates =
        input.action === 'next'
          ? state.records.filter(
              (record) =>
                record.continuation &&
                !feedbackWorkStarted(record) &&
                record.result &&
                record.threadId &&
                record.worktree &&
                !record.supersededBy &&
                !record.retired &&
                !record.retirement &&
                !record.feedbackReactivation &&
                !record.reset &&
                (['implementation', 'delivery'].includes(issueWorkflowProgress(record).action) ||
                  [
                    'continuation-auto-wait',
                    'continuation-assessment-not-actionable',
                    'continuation-turn-ended',
                  ].includes(record.continuation.code ?? '')),
            )
          : state.records.filter((record) => record.id === input.id);
      if (!candidates.length && input.action !== 'next')
        throw new Error('continuation-record-missing');
      for (const record of candidates) {
        const result = await advanceCodexWork(record, context);
        if (result !== undefined) return result;
      }
      return decisionPending ?? { status: 'idle' as const };
    }, input.action !== 'next');
    if (
      input.action === 'context' &&
      'resultContract' in response &&
      response.resultContract === 'implementation-result/v1'
    )
      return implementationMaterial(response, { action: 'context', id: input.id }, input.material);
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
          const admitted =
            record && dispatchAdmission(record, (await live.store.read())?.records ?? []);
          if (!admitted) throw new Error('continuation-admission-missing');
          const held = liveWorkflowPolicy(
            live.manifest,
            'codex',
            admitted,
            record && retainedIssueProgression(record) ? 'continued-work' : 'implementation',
          );
          if (held) throw new WorkflowPolicyHeld(held);
          const fresh = record?.manualIssue
            ? { sourceThreadId: record.sourceThreadId }
            : await (deps.activation ?? inspectCodexDispatchActivation)(
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
    return delivery;
  } finally {
    await connection?.close();
  }
}
import acceptCodexIntakeOccurrence from './codex-intake-occurrence.ts';
