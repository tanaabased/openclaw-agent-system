import { nativeObject } from './automation-gateway.ts';
import CodexAssignmentClaims, { codexInstanceStore } from './codex-assignment-claims.ts';
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
import recoverDispatch from './codex-dispatch-recovery.ts';
import reportDispatch, { failDispatch, notice } from './codex-dispatch-reporting.ts';
import validateDispatchRequest from './codex-dispatch-request.ts';
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
  validateDispatchRequest(action, input);
  deps = {
    ...deps,
    claims: deps.claims ?? new CodexAssignmentClaims(codexInstanceStore(pluginData)),
  };
  if (action === 'next') {
    const retirement = await reconcileCodexLifecycle(pluginData, deps, input.threads);
    if (retirement) return retirement;
    const feedback = await runCodexFeedback(pluginData, { action: 'next' }, deps);
    if (!['idle', 'disabled'].includes(feedback.status)) return feedback;
  }
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
  const operatorAction = operatorRecovery || operatorReset || operatorRetire;
  const childAction = action === 'context' || action === 'result' || action === 'summary';
  const retainedWork = childAction || action === 'reconcile' || action === 'report';
  if (!retainedWork && !current.policy) throw new Error('dispatch-policy-disabled');
  const activation = await (deps.activation ?? inspectCodexDispatchActivation)(
    pluginData,
    { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
    operatorRecovery,
    true,
  );
  if (operatorAction && caller === activation.sourceThreadId)
    throw new Error('dispatch-operator-caller-required');
  if (!operatorAction && !childAction && caller !== activation.sourceThreadId)
    throw new Error('dispatch-intake-caller-required');
  const admitted = await current.store.read();
  if (!admitted) throw new Error('dispatch-policy-reconciliation-required');
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
        if (action !== 'report') {
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
        const allowed = await (deps.activation ?? inspectCodexDispatchActivation)(
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
          slots: codexIntakePolicy(current.manifest)?.policy.maxConcurrentItems ?? 3,
        });
      if (action === 'next') return nextDispatch(input, tx);
      if (typeof input.id !== 'string') throw new Error('dispatch-request-invalid');
      const record = state.records.find((entry) => entry.id === input.id);
      const intake = record && admitted.records.find((entry) => entry.id === record.intakeId);
      if (!record || !intake) throw new Error('dispatch-receipt-missing');
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
      if (record.retired || (record.retirement && !operatorRetire))
        throw new Error('dispatch-assessment-retired');
      if (record.handoff && !operatorRetire && action !== 'summary')
        throw new Error('dispatch-assessment-handed-off');
      if (action === 'retire' || action === 'reset' || action === 'retry-denied')
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
          graceMinutes: current.policy?.policy.cleanup?.graceMinutes ?? 60,
          save,
          fresh,
          revalidate: () =>
            revalidateDispatchAssignment(
              current,
              action === 'retry-denied'
                ? (admitted.records.findLast((entry) => issueKey(entry) === record.issueKey) ??
                    intake)
                : intake,
              deps,
              signal,
            ),
          connect: () => (deps.connect ?? connectCodexGitHub)(current.workspace, signal),
          withNative: (operation) => withNative(current, deps, operation),
        });
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
