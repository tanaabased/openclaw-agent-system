import { automationHash } from './automation-hash.ts';
import codexIssueLaunch from './codex-issue-launch.ts';
import { managedIssueState, dispatchAdmission } from './managed-issue.ts';
import { parseDirectImplementationRequest } from '../tools/dispatch/implementation-schema.ts';
import codexImplementationEntry from './codex-implementation-entry.ts';
import runCodexContinuation from './codex-continuation.ts';
import codexAssessmentEntry from './codex-assessment-entry.ts';
import cleanupConfiguration from './cleanup-configuration.ts';
import { nativeObject } from './automation-gateway.ts';
import { codexInstanceStore } from './codex-assignment-claims.ts';
import reconcileCodexLifecycle from './codex-assignment-lifecycle.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import reconcileCodexCapacity from './codex-capacity-reconcile.ts';
import { nextDispatch, prepareDispatch, recover } from './codex-dispatch-admission.ts';
import { assessDispatch, handoffDispatch, presentDispatch } from './codex-dispatch-assessment.ts';
import {
  issueUrl,
  revalidateDispatchAssignment,
  withNative,
  type CodexDispatchDependencies,
  type CodexDispatchTransaction,
} from './codex-dispatch-context.ts';
import reconcileIntakeDenial from './codex-dispatch-denial.ts';
import recoverDispatch from './codex-dispatch-recovery.ts';
import liveWorkflowPolicy from './live-workflow-policy.ts';
import reportDispatch, { failDispatch, notice } from './codex-dispatch-reporting.ts';
import validateDispatchRequest from './codex-dispatch-request.ts';
import retireCodexNative from './codex-native-retirement.ts';
import CodexDispatchStore, { type DispatchRecord } from './codex-dispatch-state.ts';
import runCodexFeedback from './codex-feedback.ts';
import acceptCodexIntakeOccurrence from './codex-intake-occurrence.ts';
import { codexIntakePolicy } from './codex-intake-policy.ts';
import { connectCodexGitHub, selectCodexIntake } from './codex-intake.ts';
import { issueKey } from './dispatch-pending.ts';
import retainedIntakePolicy from './retained-intake-policy.ts';
import workflowRecovery from './workflow-recovery.ts';
import workflowStatus from './workflow-status.ts';

export { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
export type { CodexDispatchDependencies } from './codex-dispatch-context.ts';
/** authorized scheduled dispatch only; host tools execute the one durably prepared native request. */
export async function runCodexDispatch(
  pluginData: string,
  action: string,
  input: unknown,
  deps: CodexDispatchDependencies = {},
) {
  if (action === 'launch')
    return codexIssueLaunch(pluginData, { ...(input as Record<string, unknown>), action }, deps);
  if (action === 'implementation') {
    const request = parseDirectImplementationRequest({
      ...(input as Record<string, unknown>),
      action,
    });
    const context = await codexImplementationEntry(pluginData, request, deps);
    if (context.status !== 'managed' || !('owner' in context) || !context.owner) return context;
    if (context.owner.eventId) {
      if (request.operation === 'delivery')
        throw new Error('implementation-feedback-delivery-owner-required');
      return runCodexFeedback(
        pluginData,
        {
          action:
            request.operation === 'result' ? 'implementation-result' : 'implementation-context',
          id: context.owner.id,
          eventId: context.owner.eventId,
          ...(request.result ? { implementationResult: request.result } : {}),
        },
        deps,
      );
    }
    return runCodexContinuation(
      pluginData,
      {
        action:
          request.operation === 'delivery'
            ? 'delivery'
            : request.operation === 'result'
              ? 'result'
              : 'context',
        id: context.owner.id,
        ...(request.result ? { result: request.result } : {}),
        ...(request.operation === 'delivery'
          ? {
              delivery: {
                action: request.deliveryOperation,
                title: request.title,
                body: request.body,
                digest: request.digest,
              },
            }
          : {}),
      },
      { ...deps, directOperator: true, directScope: request.scope },
    );
  }
  if (action === 'assessment')
    return codexAssessmentEntry(
      pluginData,
      { ...(input as Record<string, unknown>), action },
      deps,
    );
  validateDispatchRequest(action, input);
  if (action === 'retire' && typeof input.native === 'string')
    return retireCodexNative(
      pluginData,
      { native: input.native, digest: input.digest as string | undefined },
      deps,
    );
  deps = {
    ...deps,
    claimStore: deps.claimStore ?? codexInstanceStore(pluginData),
  };
  if (action === 'next') {
    const observation = await executeCodexDispatch(pluginData, 'observe-denials', {}, deps);
    if (!observation || !('status' in observation) || observation.status !== 'ready')
      return observation;
    const retirement = await reconcileCodexLifecycle(pluginData, deps, input.threads);
    if (retirement) return retirement;
    const feedback = await runCodexFeedback(pluginData, { action: 'next' }, deps);
    if (!['idle', 'disabled'].includes(feedback.status)) return feedback;
  }
  return executeCodexDispatch(pluginData, action, input, deps);
}

async function executeCodexDispatch(
  pluginData: string,
  action: string,
  input: unknown,
  deps: CodexDispatchDependencies,
) {
  validateDispatchRequest(action, input);
  const current = await selectCodexIntake(pluginData, deps);
  const retainedAdmission = await current.store.read();
  if (retainedAdmission?.records.length)
    current.policy ??= retainedIntakePolicy(current.manifest, retainedAdmission, 'codex');
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  if (action === 'inspect') {
    const state = await store.read();
    return {
      ...state,
      records: state.records.map((record) => ({
        ...record,
        workflowStatus: workflowStatus(record),
        assignmentObservation: record.assignmentObservation,
        assignmentWarning:
          record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
      })),
    };
  }
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('dispatch-native-caller-required');
  if (action === 'present') return presentDispatch(input, current, store, caller, deps);
  if (action === 'handoff') return handoffDispatch(input, current, store, caller, deps);
  const operatorRecovery = action === 'retry-denied';
  const operatorReset = action === 'reset';
  const operatorRetire = action === 'retire';
  const operatorAction =
    operatorRecovery || operatorReset || operatorRetire || action === 'recover';
  const childAction = action === 'context' || action === 'result' || action === 'summary';
  const retainedWork = childAction || action === 'reconcile' || action === 'report';
  const manualOwner =
    (childAction || operatorAction) && 'id' in input
      ? (await store.read()).records.find(
          (record) => record.id === input.id && (record.manualIssue || action === 'recover'),
        )
      : undefined;
  if (!retainedWork && !current.policy && !manualOwner) throw new Error('dispatch-policy-disabled');
  const activation = manualOwner
    ? { sourceThreadId: manualOwner.sourceThreadId }
    : await (deps.activation ?? inspectCodexDispatchActivation)(
        pluginData,
        { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
        operatorRecovery,
        true,
      );
  if (operatorAction && !manualOwner && caller === activation.sourceThreadId)
    throw new Error('dispatch-operator-caller-required');
  if (!operatorAction && !childAction && caller !== activation.sourceThreadId)
    throw new Error('dispatch-intake-caller-required');
  const admitted = managedIssueState(await current.store.read(), (await store.read()).records);
  if (!admitted) throw new Error('dispatch-policy-reconciliation-required');
  current.policy ??= retainedIntakePolicy(current.manifest, admitted, 'codex');
  const now = (deps.now ?? Date.now)();
  const waitForLock = childAction || action === 'report';
  return store
    .exclusive(async (state, save, signal) => {
      if (!operatorAction && !childAction) {
        const occurrence = await withNative(current, deps, (host) => host.occurrence(caller));
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
        if (action !== 'report' && action !== 'observe-denials') {
          if (state.run!.actions >= 12) {
            await save();
            return { status: 'budget-exhausted', changed: false, nextAction: 'report' };
          }
          state.run!.actions++;
        }
        await save();
      }
      const fresh = async () => {
        const selected = await selectCodexIntake(pluginData, deps);
        const allowed = manualOwner
          ? { sourceThreadId: manualOwner.sourceThreadId }
          : await (deps.activation ?? inspectCodexDispatchActivation)(
              pluginData,
              { codexHome: selected.codexHome, inspectBinding: deps.inspectBinding },
              operatorRecovery,
              true,
            );
        if (
          selected.store.location.scope !== current.store.location.scope ||
          allowed.sourceThreadId !== activation.sourceThreadId
        )
          throw new Error('dispatch-workspace-binding-changed');
      };
      const tx: CodexDispatchTransaction = {
        pluginData,
        current,
        deps,
        state,
        admitted,
        activation,
        caller,
        now,
        signal,
        save,
        fresh,
      };
      const fail = (record: DispatchRecord, error: unknown) => failDispatch(record, error, tx);
      if (action === 'report')
        return reportDispatch(input, {
          state,
          admitted,
          intakeStore: current.store,
          now,
          save,
          debug: current.manifest.debug,
          slots: codexIntakePolicy(current.manifest)?.policy.maxConcurrentItems ?? 3,
        });
      if (action === 'observe-denials') {
        // reconcile anchored refusals before selecting or reclassifying any pending operation.
        for (const record of state.records.filter(
          (entry) => !entry.supersededBy && !entry.retired && !entry.reset && !entry.retirement,
        )) {
          try {
            await reconcileIntakeDenial(record, tx);
          } catch (error) {
            const result = await fail(record, error);
            if (state.run) state.run.stopped = 'blocked';
            await save();
            return {
              ...result,
              nextAction: 'report',
              instruction:
                'Native refusal evidence is shared, ambiguous, or unavailable. Stop this occurrence and report it; do not retry the held action.',
            };
          }
        }
        return { status: 'ready', changed: false, nextAction: 'next' };
      }
      if (action === 'next') return nextDispatch(input, tx);
      if (typeof input.id !== 'string') throw new Error('dispatch-request-invalid');
      const record = state.records.find((entry) => entry.id === input.id);
      const intake = record && dispatchAdmission(record, admitted.records ?? []);
      if (!record || !intake) throw new Error('dispatch-receipt-missing');
      if (record.supersededBy && action !== 'recover') throw new Error('dispatch-task-superseded');
      if (record.reset) throw new Error('dispatch-assessment-reset');
      if (record.retired && action === 'reconcile') {
        const observation = await withNative(current, deps, (native) =>
          reconcileCodexCapacity(record, native, state.run!.id, now, true),
        );
        await save();
        return {
          id: record.id,
          status: record.nativeInactive ? 'inactive' : 'waiting',
          capacityObservation: observation,
          nextAction: 'next',
        };
      }
      if (record.retired && operatorRetire && record.sourceThreadId === activation.sourceThreadId)
        return record.retirement?.worktreeRemovedAt === undefined ||
          (record.retirement.archivedAt === undefined &&
            !record.retirement.sessionUnavailableObserved)
          ? {
              status: 'retirement-unverified',
              id: record.id,
              code: 'retirement-legacy-outcome-unverified',
              instruction:
                'Recover native session and checkout outcomes through the owning lifecycle; the historical retired marker alone is not completion evidence.',
            }
          : { status: 'retired', id: record.id, retirement: record.retirement };
      if (record.retired || (record.retirement && !operatorRetire))
        throw new Error('dispatch-assessment-retired');
      if (record.handoff && !operatorRetire && action !== 'summary' && action !== 'recover')
        throw new Error('dispatch-assessment-handed-off');
      if (
        action === 'recover' ||
        action === 'retire' ||
        action === 'reset' ||
        action === 'retry-denied'
      )
        return recoverDispatch(input, {
          action,
          state,
          record,
          intake,
          sourceThreadId: activation.sourceThreadId,
          manifestDigest: current.digest,
          issueUrl: issueUrl(intake),
          caller,
          now,
          readConfiguration: cleanupConfiguration,
          save,
          fresh: async () => {
            await fresh();
            if (
              action === 'retry-denied' &&
              (await selectCodexIntake(pluginData, deps)).digest !== current.digest
            )
              throw new Error('dispatch-recovery-stale');
          },
          revalidate: () => {
            const latest =
              action === 'retry-denied'
                ? (admitted.records.findLast((entry) => issueKey(entry) === record.issueKey) ??
                  intake)
                : intake;
            if (action === 'retry-denied' && liveWorkflowPolicy(current.manifest, 'codex', latest))
              throw new Error('dispatch-recovery-policy-held');
            return revalidateDispatchAssignment(
              current,
              latest,
              deps,
              signal,
              action === 'recover',
              action === 'recover' ? record : undefined,
            );
          },
          connect: () => (deps.connect ?? connectCodexGitHub)(current.workspace, signal),
          withNative: (operation) => withNative(current, deps, operation),
          deliveryConnect: deps.deliveryConnect,
          git: deps.git,
          ...(!('initiation' in intake) && deps.claims?.recover
            ? {
                claim: async (operation: 'preview' | 'reserve') => {
                  const checked = await revalidateDispatchAssignment(
                    current,
                    intake,
                    deps,
                    signal,
                    true,
                    record,
                  );
                  return deps.claims!.recover!(
                    intake,
                    checked.client,
                    record,
                    automationHash([record.id, 'recovery']),
                    operation,
                  );
                },
              }
            : {}),
        });
      if (action === 'prepare' || action === 'reconcile') {
        if (
          await reconcileIntakeDenial(
            record,
            tx,
            action === 'prepare' &&
              record.preparationObservation?.sourceThreadId === caller &&
              record.preparationObservation?.turnId === state.run?.id,
          )
        )
          return { ...notice(record, intake), denial: record.denial };
      }
      if (action === 'prepare') return prepareDispatch(input, record, intake, tx);
      if (action === 'reconcile' || childAction) {
        try {
          if (action === 'reconcile' && input.receipt !== undefined) {
            if (
              !nativeObject(input.receipt) ||
              Object.keys(input.receipt).some(
                (key) => !['threadId', 'clientThreadId', 'hostId'].includes(key),
              ) ||
              (input.receipt.hostId !== undefined && input.receipt.hostId !== 'local')
            )
              throw new Error('dispatch-native-receipt-invalid');
            for (const key of ['threadId', 'clientThreadId'] as const) {
              const value = input.receipt[key];
              if (value !== undefined) {
                if (
                  typeof value !== 'string' ||
                  !value ||
                  value.length > 4096 ||
                  (record[key === 'threadId' ? 'receiptThreadId' : key] &&
                    record[key === 'threadId' ? 'receiptThreadId' : key] !== value)
                )
                  throw new Error('dispatch-native-receipt-invalid');
                if (
                  state.records.some(
                    (other) =>
                      other.id !== record.id &&
                      [other.threadId, other.receiptThreadId, other.clientThreadId].includes(value),
                  )
                )
                  throw new Error('dispatch-native-receipt-reused');
              }
            }
            // validate the entire receipt before retaining either identity.
            if (input.receipt.threadId !== undefined)
              record.receiptThreadId = input.receipt.threadId as string;
            if (input.receipt.clientThreadId !== undefined)
              record.clientThreadId = input.receipt.clientThreadId as string;
            await save();
          }
          if (childAction && record.threadId && record.threadId !== caller)
            throw new Error('dispatch-assessment-caller-mismatch');
          await revalidateDispatchAssignment(current, intake, deps, signal, true, record);
          const native = await recover(
            current,
            record,
            intake,
            deps,
            save,
            childAction ? caller : (record.threadId ?? record.receiptThreadId),
            action === 'summary' ? 'handoff' : 'assessment',
            true,
            state.records,
          );
          await fresh();
          if (childAction) return assessDispatch(action, input, record, intake, native, tx);
          const result = notice(record, intake);
          await save();
          return result;
        } catch (error) {
          if (childAction) throw error;
          return fail(record, error);
        }
      }
      throw new Error('dispatch-action-invalid');
    }, waitForLock)
    .then(async (result) => {
      if (operatorRetire && input.digest !== undefined && result?.status === 'retirement-pending')
        return (
          (await reconcileCodexLifecycle(pluginData, deps, input.threads, {
            id: String(input.id),
            caller,
          })) ?? result
        );
      return result;
    })
    .catch((error: unknown) => {
      if (nativeObject(error) && error.code === 'private-state-file-lock-busy')
        return {
          status: 'busy',
          changed: false,
          ...(childAction
            ? {
                instruction:
                  'The dispatch journal is temporarily busy. Retry this same request; do not investigate or create another chat.',
              }
            : {}),
        };
      throw error;
    });
}
