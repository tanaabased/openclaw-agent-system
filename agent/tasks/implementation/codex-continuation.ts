import { withDispatchTask } from '../../dispatch-task-scope.ts';
import { Value } from 'typebox/value';
import recoverCodexAnnouncement from '../delivery/codex-announcement-recovery.ts';
import codexCommit from '../../codex-commit.ts';
import authorizeCodexFeedback from '../../codex-feedback-authority.ts';
import connectCodexFeedback from '../../codex-feedback-client.ts';
import codexFeedbackInput from '../../codex-feedback-input.ts';
import codexWorkState from './codex-work-state.ts';
import implementationMaterial from './implementation-material.ts';
import { dispatchAdmission, managedIssueState } from '../../managed-issue.ts';
import taskRecoveryCaller from '../../task-recovery-caller.ts';
import workflowFailure from '../../workflow-failure.ts';

import { inspectCodexDispatchActivation } from '../../codex-automations.ts';
import {
  requestSchema,
  type CodexContinuationDependencies,
  type CodexWorkContext,
} from './codex-continuation-context.ts';
import codexContinuationNative from './codex-continuation-native.ts';
import runCodexDelivery from '../delivery/codex-delivery.ts';
import { codexDispatchNative } from '../../codex-dispatch-native.ts';
import { dispatchGit } from '../../codex-dispatch-project.ts';
import CodexDispatchStore from '../../codex-dispatch-state.ts';
import { selectCodexTaskContext } from '../context/codex-task-context.ts';
import codexLiveTurn from '../../codex-live-turn.ts';
import { connectCodexThreads } from '../../codex-thread-client.ts';
import advanceCodexWork, { prepareCodexWork } from './codex-work.ts';
import { retainedIssueProgression } from '../../issue-progression.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from '../../live-workflow-policy.ts';
import { requireWorkflowSchedule } from '../../workflow-schedule.ts';

export type { CodexContinuationDependencies } from './codex-continuation-context.ts';
/** work mode is standing authority; these checks never ask for another stage approval. */
export default function runCodexContinuation(
  ...args: Parameters<typeof runCodexContinuationScoped>
) {
  const deps = args[2] ?? {};
  return withDispatchTask('codex', deps.threadId ?? process.env.CODEX_THREAD_ID, () =>
    runCodexContinuationScoped(...args),
  );
}
async function runCodexContinuationScoped(
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
  const current = await selectCodexTaskContext(pluginData, deps);
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  const retryDenied = input.action === 'retry-denied';
  const retry = input.action === 'retry' || retryDenied;
  if (!caller) throw new Error('continuation-caller-required');
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  const localOwner = (await store.read()).records.find(
    (record) =>
      record.id === input.id &&
      record.threadId === caller &&
      !['next', 'reconcile'].includes(input.action),
  );
  const activation = localOwner
    ? { sourceThreadId: localOwner.sourceThreadId }
    : await (deps.activation ?? inspectCodexDispatchActivation)(
        pluginData,
        { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
        false,
        true,
        input.action === 'delivery' ? 'publication' : 'implementation',
      );
  const schedule = activation.schedule;
  if (!schedule && !localOwner) throw new Error('workflow-schedule-reconciliation-required');
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
  let entered = false;
  const commitOptions = {
    ...codexCommit(
      current.policy?.policy.maxConcurrentItems,
      input.id,
      input.action === 'next' || input.action === 'reconcile' ? undefined : 'continuation',
    ),
    operation: 'continuation-checkpoint' as const,
  };
  try {
    const response = await store.transaction(async (state, save, signal) => {
      entered = true;
      if (retry) {
        const record = state.records.find((entry) => entry.id === input.id);
        if (!record) throw new Error('continuation-record-missing');
        if (taskRecoveryCaller(record, caller))
          throw new Error('continuation-operator-caller-required');
        await native.operatorInput(caller);
      }
      const occurrence =
        input.action === 'next' || input.action === 'reconcile'
          ? await native.occurrence(caller)
          : undefined;
      if (occurrence && occurrence.automationId !== schedule?.current.automationId)
        throw new Error('continuation-occurrence-mismatch');
      if (occurrence) {
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
      };
      if (localOwner?.feedback?.events.length && input.action !== 'cancel') {
        const found = await native.find({
          sourceThreadId: localOwner.sourceThreadId,
          prompt: localOwner.request!.prompt,
          createdAfter: localOwner.createdAt,
          threadId: caller,
        });
        const source =
          found?.turnId &&
          (await codexFeedbackInput(state.records, caller, found.turnId, continuationNative));
        if (source) {
          const admitted = dispatchAdmission(source.record, admissions?.records ?? []);
          if (!admitted) throw new Error('feedback-admission-missing');
          const provider = await (deps.feedbackConnect ?? connectCodexFeedback)(
            current.workspace,
            signal,
          );
          const authorize = async () =>
            authorizeCodexFeedback({
              conversation: true,
              current: await selectCodexTaskContext(pluginData, deps),
              record: source.record,
              event: source.event,
              intake: admitted,
              provider,
            });
          await authorize();
          context.feedbackInput = {
            turnId: found!.turnId!,
            inputId: source.attempt.id,
            attempt: source.attempt,
            authorize,
          };
        }
      }
      if (!context.feedbackInput && ['context', 'result'].includes(input.action)) {
        const record = state.records.find(
          (entry) => entry.id === input.id && entry.threadId === caller,
        );
        const found =
          record?.request &&
          (await native.find({
            sourceThreadId: record.sourceThreadId,
            prompt: record.request.prompt,
            createdAfter: record.createdAt,
            threadId: caller,
          }));
        if (deps.directOperator || found?.followUpUserTurn) {
          try {
            context.operatorInput = await native.operatorInput(caller);
          } catch (error) {
            // Existing task permission does not depend on a new human message.
            if (!(error instanceof Error) || error.message !== 'reply-native-user-input-required')
              throw error;
            if (
              deps.directScope &&
              deps.directScope !== ((record && codexWorkState(record)?.scope) ?? 'pull-request')
            )
              throw error;
          }
        }
      }
      if (input.action === 'next' || input.action === 'reconcile') {
        for (const record of state.records) {
          if (record.announcement?.attempted && !record.announcement.receipt)
            await recoverCodexAnnouncement(record, context);
        }
        return { status: 'reconciled' as const };
      }
      if (!input.material) await prepareCodexWork(state, context);
      const candidates = state.records.filter((record) => record.id === input.id);
      if (!candidates.length) throw new Error('continuation-record-missing');
      for (const record of candidates) {
        const result = await advanceCodexWork(record, context);
        if (result === undefined) continue;
        return result;
      }
      return { status: 'idle' as const };
    }, commitOptions);
    if (
      input.action === 'context' &&
      response.status === 'verified' &&
      'implementation' in response
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
          const live = await selectCodexTaskContext(pluginData, deps);
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
          const fresh =
            record?.threadId === caller || record?.manualIssue
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
    if ('publishRequest' in delivery && delivery.publishRequest) {
      const publication = delivery.publishRequest;
      return {
        ...delivery,
        publishRequest: {
          action: 'delivery' as const,
          delivery: publication,
        },
      };
    }
    return delivery;
  } catch (error) {
    const failure = workflowFailure(error, 'continuation-operation-failed');
    if (
      !entered &&
      ['next', 'reconcile'].includes(input.action) &&
      failure.code === 'private-state-file-lock-busy'
    )
      return { status: 'busy' as const, changed: false, ...failure };
    throw error;
  } finally {
    await connection?.close();
  }
}
