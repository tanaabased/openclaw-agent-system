import { selectWorkflowStage } from './workflow-stage.ts';
import openClawSkill from './openclaw-skill.ts';
import nativeFeedbackSource from './native-feedback-source.ts';
import { selectedOpenClawFeedback } from './openclaw-feedback-input.ts';
import { dispatchAdmission } from './managed-issue.ts';
import {
  assertNativeContextInput,
  isNativeContextRequest,
  isNativeFeedbackRequest,
  nativeContextRequest,
  nativeContextResponse,
} from './native-context-request.ts';
import launchPending from './launch-pending.ts';
import renderNativeAssessment, { renderBoundAssessment } from './assessment-render.ts';
import feedbackContextMaterial from './feedback-context-material.ts';
import dispatchInspection, { dispatchInspectionSummary } from './dispatch-inspection.ts';
import { isDeepStrictEqual } from 'node:util';

import assessmentMaterial from './assessment-material.ts';
import implementationMaterial from './implementation-material.ts';
import recoverOpenClawTask from './openclaw-dispatch-recovery.ts';
import issueLaunch from './issue-launch.ts';
import openClawEntryContext from './openclaw-entry-context.ts';
import { Value } from 'typebox/value';
import { launchRequestSchema } from '../tools/dispatch/launch-schema.ts';
import openClawImplementationEntry from './openclaw-implementation-entry.ts';
import openClawAssessmentEntry from './openclaw-assessment-entry.ts';
import retireOpenClawTask from './openclaw-dispatch-retirement.ts';
import retireOpenClawNative from './openclaw-native-retirement.ts';
import pendingPublicResponse from './pending-public-response.ts';
import openClawReply from './openclaw-reply.ts';
import type { Static } from 'typebox';

import { stateSnapshotConflictCode } from '../core/merge-state-snapshot.ts';
import { privateStateFileLockBusyErrorCode } from '../core/private-state-file-lock.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { dispatchModelParameters, type dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import discoveryCheckpoint from './discovery-checkpoint.ts';
import discoveryNotice from './discovery-notice.ts';
import { dispatchFailurePhase, scheduleDispatchRetry } from './dispatch-retry.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import reconcileOpenClawLifecycle from './openclaw-assignment-lifecycle.ts';
import dispatchCapacity from './openclaw-capacity.ts';
import OpenClawDispatchAdmission from './openclaw-dispatch-admission.ts';
import OpenClawDispatchContext, {
  type OpenClawDispatchDependencies,
  openClawDispatchFailureCode,
  type OpenClawDispatchTransaction,
} from './openclaw-dispatch-context.ts';

import OpenClawDispatchCoordinator from './openclaw-dispatch-coordinator.ts';
import OpenClawDispatchIssue from './openclaw-dispatch-issue.ts';
import OpenClawDispatchStore, {
  preserveOpenClawProgress,
  type OpenClawDispatchRecord,
} from './openclaw-dispatch-state.ts';
import { applyOpenClawFeedbackScans, scanOpenClawFeedback } from './openclaw-feedback-scan.ts';
import { sameIntakeRun } from './openclaw-intake-pass.ts';
import {
  describeIssueSession,
  IssueSessionMismatchError,
  type DispatchCaller,
} from './openclaw-session-create.ts';
import workflowFailure from './workflow-failure.ts';
import workflowRecovery from './workflow-recovery.ts';
import workflowStatus from './workflow-status.ts';

export { openClawDispatchFailureCode } from './openclaw-dispatch-context.ts';
export type { OpenClawDispatchDependencies } from './openclaw-dispatch-context.ts';
export default class OpenClawDispatch {
  private readonly context: OpenClawDispatchContext;
  private readonly issue: OpenClawDispatchIssue;
  private readonly coordinator: OpenClawDispatchCoordinator;
  private readonly admission: OpenClawDispatchAdmission;
  constructor(readonly dependencies: OpenClawDispatchDependencies) {
    this.context = new OpenClawDispatchContext(dependencies);
    this.issue = new OpenClawDispatchIssue(this.context);
    this.coordinator = new OpenClawDispatchCoordinator(this.context, this.issue, (...args) =>
      this.validate(...args),
    );
    this.admission = new OpenClawDispatchAdmission(this.context);
  }
  scope(...args: Parameters<OpenClawDispatchContext['scope']>) {
    return this.context.scope(...args);
  }
  validate(...args: Parameters<OpenClawDispatchContext['validate']>) {
    return this.context.validate(...args);
  }
  promptContext(...args: Parameters<OpenClawDispatchContext['promptContext']>) {
    return this.context.promptContext(...args);
  }
  check(...args: Parameters<OpenClawDispatchCoordinator['check']>) {
    return this.coordinator.check(...args);
  }
  private async block(
    store: OpenClawDispatchStore,
    id: string,
    error: unknown,
    stage?: OpenClawDispatchRecord['failureStage'],
  ) {
    const code = openClawDispatchFailureCode(error);
    let status: 'blocked' | 'waiting' | 'retrying' = 'waiting';
    await store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (record) {
        record.blocker = code;
        scheduleDispatchRetry(record, code, error, (this.dependencies.now ?? Date.now)());
        if (stage) record.failureStage = stage;
        status = dispatchFailurePhase(record, code, error);
        if (record.phase !== 'complete') record.phase = status;
        await save();
      }
    }, true);
    return {
      status,
      id,
      nextAction: 'next' as const,
      ...workflowFailure(error, code),
      ...(stage ? { stage } : {}),
      ...(error instanceof IssueSessionMismatchError ? { mismatchedField: error.field } : {}),
    };
  }

  async runModel(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    input: Record<string, unknown>,
    operator = false,
    authority: DispatchAuthority = {},
  ) {
    if (isNativeContextRequest('dispatch', input)) assertNativeContextInput(input);
    if (!Value.Check(dispatchModelParameters, input as unknown))
      throw new Error('dispatch-model-request-invalid');
    let request = input;
    if (isNativeContextRequest('dispatch', input)) {
      assertNativeContextInput(input);
      const current = await this.scope(manifest, workspace);
      const owners = (await current.journal.read()).records.filter(
        (record) => record.threadId === caller.sessionKey,
      );
      if (owners.length > 1) throw new Error('native-context-owner-ambiguous');
      const owner = owners[0];
      request = nativeContextRequest(input, owner);
      if (isNativeFeedbackRequest('dispatch', input)) {
        const admission = dispatchAdmission(owner!, current.admitted.records);
        const event = nativeFeedbackSource(
          owner?.feedback?.events ?? [],
          owner && selectedOpenClawFeedback(owner, caller.runId)?.id,
          admission && `${admission.repository.owner.login}/${admission.repository.name}`,
          input.source,
        );
        const authored = { ...request };
        delete authored.source;
        request = { ...authored, eventId: event.id };
      }
    }
    return nativeContextResponse(
      await this.run(
        manifest,
        workspace,
        caller,
        request as Static<typeof dispatchParameters>,
        operator,
        authority,
      ),
      'dispatch',
      typeof input.source === 'string' ? input.source : undefined,
    );
  }

  async run(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    input: Static<typeof dispatchParameters>,
    operator = false,
    authority: DispatchAuthority = {},
  ) {
    if (
      'material' in input &&
      input.material &&
      !(
        input.action === 'context' ||
        (input.action === 'implementation-context' && !input.scope) ||
        (input.action === 'summary' &&
          input.operation === 'compose' &&
          !input.digest &&
          !input.publicText &&
          !input.diagnostic) ||
        (input.action === 'feedback' &&
          ['context', 'implementation-context', 'compose'].includes(input.operation) &&
          !input.decision) ||
        (input.action === 'assessment' && ['context', 'render'].includes(input.operation)) ||
        (input.action === 'delivery' &&
          input.operation === 'compose' &&
          !input.publicText &&
          !input.title &&
          !input.body &&
          input.pullRequest === undefined) ||
        (input.action === 'reply' && ['context', 'compose'].includes(input.operation)) ||
        (input.action === 'implementation' &&
          input.operation === 'context' &&
          !input.scope &&
          !input.plan)
      )
    )
      throw new Error('implementation-material-request-invalid');
    const response = await (input.action === 'launch'
      ? this.launch(manifest, workspace, caller, input, operator, authority)
      : this.execute(manifest, workspace, caller, input, operator, authority));
    if (
      input.action === 'implementation-context' ||
      (input.action === 'feedback' && input.operation === 'implementation-context')
    ) {
      if (response.status === 'verified' && 'implementation' in response) {
        const request =
          input.action === 'feedback'
            ? {
                action: 'feedback',
                operation: 'implementation-context',
                id: input.id,
                eventId: input.eventId,
              }
            : { action: 'implementation-context', id: input.id };
        return implementationMaterial(response, request, input.material);
      }
    }
    if (
      input.action === 'feedback' &&
      input.operation === 'context' &&
      response.status === 'verified'
    )
      return feedbackContextMaterial(
        { ...response, id: input.id },
        { action: 'feedback', operation: 'context', id: input.id, eventId: input.eventId },
        input.material,
      );
    if (
      input.action === 'context' &&
      'resultContract' in response &&
      response.resultContract === 'assessment-result/v1'
    )
      return assessmentMaterial(response, { action: 'context', id: input.id }, input.material);
    return response;
  }
  private async launch(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    input: Extract<Static<typeof dispatchParameters>, { action: 'launch' }>,
    operator: boolean,
    authority: DispatchAuthority,
  ) {
    if (!Value.Check(launchRequestSchema, input)) throw new Error('launch-request-invalid');
    const action = input;
    const admitted = await openClawEntryContext(
      { manifest, workspace, caller, action, operator, authority, dependencies: this.dependencies },
      async (context) => {
        const selected = await this.dependencies.intake.select(manifest, workspace, {
          resolvePolicy: false,
        });
        const journal = new OpenClawDispatchStore(
          this.dependencies.root,
          selected.store.location.scope,
        );
        const client = await this.dependencies.connect(
          { manifest, workspaceDir: workspace },
          authority.signal ?? AbortSignal.timeout(60000),
        );
        return issueLaunch<OpenClawDispatchRecord>({
          action,
          context,
          journal,
          scope: selected.store.location.scope,
          client,
          create: (record) => record,
          verifyExisting: async (record) => {
            await this.dependencies.credential.use(authority, (request) =>
              describeIssueSession(request, record, this.dependencies.config(), 'retained'),
            );
          },
        });
      },
    );
    if (action.operation === 'context' || admitted.status === 'clarification-needed')
      return admitted;
    if (!action.id || !('id' in admitted) || action.id !== admitted.id)
      throw new Error('launch-receipt-required');
    const selected = await this.context.scope(manifest, workspace);
    const record = (await selected.journal.read()).records.find((entry) => entry.id === action.id);
    if (
      !record?.manualIssue ||
      record.sourceThreadId !== caller.sessionKey ||
      (admitted.status === 'existing' &&
        (!launchPending(record) || action.operation !== 'reconcile'))
    )
      return admitted;
    if (action.operation === 'prepare') {
      if (!action.assessment || !action.title || !action.digest)
        throw new Error('launch-preparation-required');
      const prepared = await this.execute(
        manifest,
        workspace,
        caller,
        {
          action: 'prepare',
          id: action.id,
          assessment: action.assessment,
          ...(action.fallback ? { fallback: action.fallback } : {}),
          title: action.title,
          digest: action.digest,
        },
        true,
        authority,
      );
      if (!prepared || !('status' in prepared) || prepared.status !== 'session-created')
        return prepared;
    }
    if (!record.sessionCreation?.verified && action.operation === 'reconcile') {
      const recovered = await this.execute(
        manifest,
        workspace,
        caller,
        { action: 'reconcile', id: action.id },
        true,
        authority,
      );
      if (!recovered || !('status' in recovered) || recovered.status !== 'session-created')
        return recovered;
    }
    return this.execute(
      manifest,
      workspace,
      caller,
      { action: 'assess', id: action.id },
      true,
      authority,
    );
  }
  private async execute(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    input: Exclude<Static<typeof dispatchParameters>, { action: 'launch' }>,
    operator = false,
    authority: DispatchAuthority = {},
  ) {
    if (input.action === 'implementation') {
      const context = await openClawImplementationEntry({
        manifest,
        workspace,
        caller,
        action: input,
        operator,
        authority,
        dependencies: this.dependencies,
      });
      let id: string;
      if (context.status === 'native' && 'id' in context) {
        if (input.operation !== 'delivery') return context;
        id = context.id;
      } else {
        if (context.status !== 'managed' || !('owner' in context) || !context.owner) return context;
        id = context.owner.id;
      }
      input =
        input.operation === 'delivery'
          ? {
              action: 'delivery',
              id,
              operation: input.deliveryOperation ?? 'prepare',
              title: input.title,
              body: input.body,
            }
          : input.operation === 'context'
            ? { action: 'implementation-context', id, scope: input.scope }
            : input.operation === 'result' && input.result
              ? { action: 'implementation-result', id, implementationResult: input.result }
              : { action: 'implementation-context', id };
    }
    if (input.action === 'assessment' && input.operation === 'render') {
      if (input.id || caller.sessionKey) {
        const current = await this.dependencies.intake.select(manifest, workspace, {
          resolvePolicy: false,
        });
        const journal = new OpenClawDispatchStore(
          this.dependencies.root,
          current.store.location.scope,
        );
        return renderBoundAssessment(input, {
          runtime: 'openclaw',
          records: (await journal.read()).records,
          admitted: (await current.store.read())?.records ?? [],
          session: caller.sessionKey,
          workspace,
          nativeContext: () =>
            this.dependencies.credential.use(authority, async (request) => {
              const { selection } = await selectWorkflowStage({
                stage: 'assessment',
                configuration: manifest.github?.notifications?.issueAssignment?.assessment,
                workspace,
                observedAt: Date.now(),
                resolveSkill: (id) =>
                  openClawSkill(
                    request,
                    { agentId: manifest.agent.id, key: caller.sessionKey },
                    id,
                  ),
              });
              return {
                assessment: selection,
                workspace,
                debug: manifest.debug,
                workflow: manifest.github?.notifications?.issueAssignment,
              };
            }),
          debug: manifest.debug,
          workflow: manifest.github?.notifications?.issueAssignment,
        });
      }
      return renderNativeAssessment(input, 'openclaw');
    }
    if (input.action === 'assessment')
      return openClawAssessmentEntry({
        manifest,
        workspace,
        caller,
        action: input,
        operator,
        authority,
        dependencies: this.dependencies,
      });
    if (input.action === 'recover')
      return recoverOpenClawTask({
        service: this.context,
        manifest,
        workspace,
        caller,
        input,
        operator,
        authority,
      });
    if (input.action === 'retire' && input.native !== undefined)
      return retireOpenClawNative({
        dependencies: this.dependencies,
        manifest,
        workspace,
        caller,
        native: input.native,
        digest: input.digest,
        operator,
        authority,
      });
    if (input.action === 'retire')
      return retireOpenClawTask({
        service: this.context,
        manifest,
        workspace,
        caller,
        input,
        operator,
        authority,
      });
    if (input.action === 'reply')
      return openClawReply({
        manifest,
        workspace,
        caller,
        action: input,
        operator,
        authority,
        dependencies: this.dependencies,
      });
    if (input.action === 'check')
      return this.check(manifest, workspace, authority.signal, input.observation);
    if (input.action === 'report')
      return this.coordinator
        .report(manifest, workspace, caller, authority)
        .catch((error: unknown) => {
          if (openClawDispatchFailureCode(error) === privateStateFileLockBusyErrorCode)
            return {
              status: 'busy' as const,
              ...workflowFailure(error, privateStateFileLockBusyErrorCode),
            };
          throw error;
        });
    if (
      input.action === 'present' ||
      (input.action === 'delivery' && input.operation === 'present')
    ) {
      const selected = await this.dependencies.intake.select(manifest, workspace);
      const admitted = (await this.context.scope(manifest, workspace)).admitted;
      if (!admitted) throw new Error('dispatch-intake-record-missing');
      const journal = new OpenClawDispatchStore(
        this.dependencies.root,
        selected.store.location.scope,
      );
      return this.issue.present(manifest, workspace, caller, input, authority, {
        admitted,
        journal,
      });
    }
    const workAction =
      input.action === 'handoff' ||
      input.action === 'implementation-context' ||
      input.action === 'implementation-result' ||
      input.action === 'delivery';
    const feedbackChild = input.action === 'feedback' && input.operation !== 'reconcile';
    const childAction =
      input.action === 'context' ||
      input.action === 'result' ||
      input.action === 'summary' ||
      workAction ||
      feedbackChild;
    const current = await this.scope(manifest, workspace);
    const retained =
      'id' in input
        ? (await current.journal.read()).records.find((record) => record.id === input.id)
        : undefined;
    const sourceThreadId =
      (childAction || retained?.manualIssue ? retained?.sourceThreadId : undefined) ??
      (await this.dependencies.coordinator(manifest, current.workspace));
    let preparationStage: OpenClawDispatchRecord['failureStage'] = 'validation';
    let enteredTransaction = false;
    if (input.action === 'retry' && !operator) throw new Error('dispatch-operator-required');
    if (
      !childAction &&
      caller.sessionKey !== sourceThreadId &&
      !(operator && ['inspect', 'retry'].includes(input.action))
    )
      throw new Error('dispatch-intake-caller-required');
    if (!childAction && !operator) {
      const before = await current.journal.read();
      if (!before.openclawOccurrence || !sameIntakeRun(before.openclawOccurrence, caller)) {
        const code = await this.dependencies.intake.readiness(manifest, current.workspace);
        if (code) throw new Error(code);
        await authority.assertCurrent?.();
        await current.journal.exclusive(
          async (state, save) => {
            await authority.assertCurrent?.();
            if (state.resetGeneration !== before.resetGeneration)
              throw new Error('notification-reset-stale-operation');
            if (state.openclawOccurrence && sameIntakeRun(state.openclawOccurrence, caller)) return;
            if (!isDeepStrictEqual(state.openclawOccurrence, before.openclawOccurrence))
              throw new Error('dispatch-occurrence-mismatch');
            state.openclawOccurrence = {
              sessionKey: caller.sessionKey,
              sessionId: caller.sessionId,
              runId: caller.runId,
            };
            await save();
          },
          true,
          'occurrence-registration',
        );
      }
    }
    if (input.action === 'next')
      await reconcileOpenClawLifecycle({ service: this, manifest, workspace, authority });
    const snapshot = await current.journal.read();
    const discover =
      input.action === 'next' &&
      (!snapshot.discoveryCheckedAt ||
        Date.now() - snapshot.discoveryCheckedAt > 120000 ||
        snapshot.records.some(
          (record) =>
            !record.supersededBy &&
            !record.retired &&
            !record.retirement &&
            !record.reset &&
            (record.feedback?.discoveryPending ||
              Object.keys(record.feedback?.discovery ?? {}).length > 0),
        )) &&
      (await current.journal.exclusive(async (state, save) => {
        if (state.discoveryRun && sameIntakeRun(state.discoveryRun, caller)) return false;
        state.discoveryRun = {
          sessionKey: caller.sessionKey,
          sessionId: caller.sessionId,
          runId: caller.runId,
        };
        await save();
        return true;
      }));
    const scans = discover
      ? await scanOpenClawFeedback({
          service: this,
          state: snapshot,
          manifest,
          workspace: current.workspace,
          sourceThreadId,
          authority,
          now: (this.dependencies.now ?? Date.now)(),
          checkpoint: (scan) => discoveryCheckpoint(current.journal, scan, authority.assertCurrent),
        })
      : [];
    const transactionOptions: Parameters<typeof current.journal.transaction>[1] = {
      signal: authority.signal,
      reconcile: preserveOpenClawProgress,
      validate: (before, after) => {
        const newlyReserved = after.records.some(
          (record) =>
            record.request &&
            !before.records.find((previous) => previous.id === record.id)?.request,
        );
        if (
          newlyReserved &&
          dispatchCapacity(
            after.records,
            current.policy.policy.maxConcurrentItems,
            after.projectPickup,
          ).occupied > current.policy.policy.maxConcurrentItems
        )
          throw new Error('dispatch-at-capacity');
        const activeKeys = after.records
          .filter(
            (record) =>
              !record.supersededBy &&
              !record.retired &&
              !record.retirement &&
              !record.reset &&
              !record.manualIssue?.fresh,
          )
          .map((record) => record.issueKey);
        if (new Set(activeKeys).size !== activeKeys.length)
          throw new Error(stateSnapshotConflictCode);
      },
    };
    return current.journal
      .transaction(async (state, save, transactionSignal) => {
        enteredTransaction = true;
        if (input.action === 'next') {
          delete state.discoveryCheckedAt;
          const presentation = discoveryNotice(state.discoveryProgress);
          if (presentation) {
            state.discoveryProgress!.reported = state.discoveryProgress!.pending;
            state.discoveryCheckedAt = Date.now();
            await save();
            return {
              status: 'discovery-progress' as const,
              presentation,
              instruction:
                'Present this status card, then call next again to process available work.',
            };
          }
        }
        if (scans.length) {
          await authority.assertCurrent?.();
          if ((await this.dependencies.coordinator(manifest, current.workspace)) !== sourceThreadId)
            throw new Error('feedback-schedule-owner-changed');
          if (applyOpenClawFeedbackScans(state.records, scans)) await save();
        }
        if (input.action === 'inspect') {
          const { records, summary, ...page } = dispatchInspection(
            state.records,
            current.admitted.records,
            input,
          );
          return {
            status: 'ready' as const,
            discoveryCheckedAt: state.discoveryCheckedAt,
            discoveryTimings: state.discoveryTimings,
            ...page,
            records: summary
              ? records.map(dispatchInspectionSummary)
              : records.map((record) => ({
                  id: record.id,
                  intakeId: record.intakeId,
                  phase: record.phase,
                  workflowStatus: workflowStatus(record),
                  assignmentObservation: record.assignmentObservation,
                  assignmentWarning:
                    record.assignmentObservation &&
                    workflowRecovery(record.assignmentObservation.code),
                  threadId: record.threadId,
                  effective: record.effective,
                  sessionCreation: record.sessionCreation,
                  firstTurn: record.firstTurn
                    ? {
                        status: record.firstTurn.status,
                        runId: record.firstTurn.runId,
                        consumedByEventId: record.firstTurn.consumedByEventId,
                        replyEventId: record.firstTurn.replyEventId,
                        executionModel: record.firstTurn.executionModel,
                        executionEffort: 'unverified',
                      }
                    : undefined,
                  assessmentTurn: record.assessmentTurn && {
                    status: record.assessmentTurn.status,
                    runId: record.assessmentTurn.runId,
                    consumedByEventId: record.assessmentTurn.consumedByEventId,
                    replyEventId: record.assessmentTurn.replyEventId,
                    executionModel: record.assessmentTurn.executionModel,
                    executionEffort: 'unverified',
                  },
                  blocker: record.blocker,
                  failureStage: record.failureStage,
                  outcome: record.result?.outcome,
                  pendingPublicResponse: pendingPublicResponse(record),
                  summaryRecovery: record.summaryRecovery && {
                    revision: record.summaryRecovery.revision,
                    runId: record.summaryRecovery.turn.runId,
                    status: record.summaryRecovery.turn.status,
                    code: record.summaryRecovery.code,
                  },
                  retirement: record.retirement,
                  retired: record.retired,
                  lifecycleCheckedAt: record.lifecycleCheckedAt,
                  lifecyclePending: record.lifecyclePending,
                  feedback: record.feedback,
                })),
          };
        }
        const now = (this.dependencies.now ?? Date.now)();
        const tx: OpenClawDispatchTransaction = {
          manifest,
          workspace,
          caller,
          authority,
          current,
          state,
          save,
          transactionSignal,
          sourceThreadId,
          now,
        };
        if (input.action === 'next') return this.coordinator.next(tx);
        const record = state.records.find((entry) => entry.id === input.id);
        if (!record) throw new Error('dispatch-receipt-missing');
        const feedback = await this.issue.routeFeedback(input, record, tx, operator);
        if (feedback !== undefined) return feedback;
        if (input.action === 'retry') {
          if (record.request) throw new Error('dispatch-native-recovery-required');
          record.manifestDigest = current.manifestDigest;
          await this.validate(manifest, workspace, record);
          record.phase = 'routing';
          delete record.blocker;
          delete record.failureStage;
          delete record.context;
          await save();
          return {
            status: 'routing-required' as const,
            id: record.id,
            instruction: 'The owning coordinator must call next for a fresh evidence snapshot.',
          };
        }
        if (
          childAction &&
          (caller.sessionKey !== record.threadId ||
            caller.sessionId !== record.sessionCreation?.sessionId ||
            !record.assessmentTurn)
        )
          throw new Error('dispatch-assessment-caller-mismatch');
        const verified = await this.validate(
          manifest,
          workspace,
          record,
          workAction || input.action === 'summary',
          false,
          undefined,
          authority.signal
            ? AbortSignal.any([authority.signal, transactionSignal])
            : transactionSignal,
          !(
            input.action === 'delivery' &&
            ['link', 'compose', 'candidate', 'announce'].includes(input.operation)
          ),
        );
        if (childAction) return this.issue.run(input, record, tx, verified, operator);
        return this.admission.run(input, record, tx, verified, (stage) => {
          preparationStage = stage;
        });
      }, transactionOptions)
      .catch(async (error: unknown) => {
        if (
          !enteredTransaction &&
          !childAction &&
          openClawDispatchFailureCode(error) === privateStateFileLockBusyErrorCode
        ) {
          authority.signal?.throwIfAborted();
          return {
            status: 'busy' as const,
            ...workflowFailure(error, privateStateFileLockBusyErrorCode),
            ...('id' in input ? { id: input.id } : {}),
          };
        }
        if (openClawDispatchFailureCode(error) === stateSnapshotConflictCode)
          return { status: 'busy' as const, code: stateSnapshotConflictCode };
        if (!enteredTransaction) throw error;
        if (error instanceof WorkflowPolicyHeld)
          return {
            status: 'policy-held' as const,
            ...('id' in input ? { id: input.id } : {}),
            reason: error.reason,
            nextAction: 'next' as const,
          };
        if (
          input.action === 'prepare' ||
          input.action === 'reconcile' ||
          input.action === 'start' ||
          input.action === 'assess'
        )
          return this.block(
            current.journal,
            input.id,
            authority.signal?.aborted ? new Error('dispatch-operation-cancelled') : error,
            preparationStage,
          );
        throw error;
      });
  }
}
