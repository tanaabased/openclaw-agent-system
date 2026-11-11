import { withDispatchTask } from './dispatch-task-scope.ts';
import dispatchCreationStatus from './dispatch-creation-status.ts';
import { isDeepStrictEqual } from 'node:util';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { stateSnapshotConflictCode } from '../core/merge-state-snapshot.ts';
import { privateStateFileLockBusyErrorCode } from '../core/private-state-file-lock.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { launchRequestSchema } from '../tools/dispatch/launch-schema.ts';
import {
  assertDispatchModelRequest,
  type dispatchParameters,
} from '../tools/dispatch/tool-schema.ts';
import assessmentMaterial from './assessment-material.ts';
import renderNativeAssessment, { renderBoundAssessment } from './assessment-render.ts';
import discoveryCheckpoint from './discovery-checkpoint.ts';
import discoveryNotice from './discovery-notice.ts';
import dispatchInspection, { dispatchInspectionSummary } from './dispatch-inspection.ts';
import { dispatchFailurePhase, scheduleDispatchRetry } from './dispatch-retry.ts';
import feedbackContextMaterial from './feedback-context-material.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from './implementation-material.ts';
import issueLaunch from './issue-launch.ts';
import launchPending from './launch-pending.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { dispatchAdmission } from './managed-issue.ts';
import {
  assertNativeContextInput,
  isNativeContextRequest,
  isNativeFeedbackRequest,
  nativeContextRequest,
  nativeContextResponse,
} from './native-context-request.ts';
import {
  isNativeDispatchSelection,
  nativeDispatchDigest,
  nativeDispatchResponse,
  nativeDispatchSelection,
} from './native-dispatch-selection.ts';
import nativeFeedbackReconciliation from './native-feedback-reconciliation.ts';
import nativeFeedbackSource from './native-feedback-source.ts';
import { nativeMaterialResponse } from './native-material.ts';
import nativeOperatorSelection from './native-operator-selection.ts';
import openClawAssessmentEntry from './openclaw-assessment-entry.ts';
import reconcileOpenClawLifecycle from './openclaw-assignment-lifecycle.ts';
import dispatchCapacity from './openclaw-capacity.ts';
import OpenClawDispatchAdmission from './openclaw-dispatch-admission.ts';
import OpenClawDispatchContext, {
  openClawDispatchFailureCode,
  type OpenClawDispatchDependencies,
  type OpenClawDispatchTransaction,
} from './openclaw-dispatch-context.ts';
import OpenClawDispatchCoordinator from './openclaw-dispatch-coordinator.ts';
import OpenClawDispatchIssue from './openclaw-dispatch-issue.ts';
import recoverOpenClawTask from './openclaw-dispatch-recovery.ts';
import retireOpenClawTask from './openclaw-dispatch-retirement.ts';
import OpenClawDispatchStore, {
  preserveOpenClawProgress,
  type OpenClawDispatchRecord,
} from './openclaw-dispatch-state.ts';
import openClawEntryContext from './openclaw-entry-context.ts';
import { resolveOpenClawTurnFeedback } from './openclaw-feedback-input.ts';
import { applyOpenClawFeedbackScans, scanOpenClawFeedback } from './openclaw-feedback-scan.ts';
import openClawImplementationEntry from './openclaw-implementation-entry.ts';
import { sameIntakeRun } from './openclaw-intake-pass.ts';
import openClawNativeMaterial from './openclaw-native-material.ts';
import retireOpenClawNative from './openclaw-native-retirement.ts';
import { nativeTurnFor } from './openclaw-native-turns.ts';
import openClawReply from './openclaw-reply.ts';
import reconcileOpenClawRetirementEffects from './openclaw-retirement-effects.ts';
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
  runModel(...args: Parameters<OpenClawDispatch['runModelScoped']>) {
    return withDispatchTask('openclaw', args[2].sessionKey, () => this.runModelScoped(...args));
  }
  private async runModelScoped(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    input: Record<string, unknown>,
    operator = false,
    authority: DispatchAuthority = {},
  ) {
    if (isNativeContextRequest('dispatch', input)) assertNativeContextInput(input);
    assertDispatchModelRequest(input);
    const modelInput = input;
    if (input.material)
      input = await this.dependencies.credential.use(authority, (request) =>
        openClawNativeMaterial(request, caller, 'agent_system_dispatch', input),
      );
    if (input.action === 'context') {
      const retained = await this.context.readTurnContext(
        manifest,
        workspace,
        { ...caller, agentId: manifest.agent.id },
        authority,
      );
      if (!retained) throw new Error('native-context-owner-unavailable');
      return nativeMaterialResponse(
        assessmentMaterial(
          retained.context,
          { action: 'context' },
          input.material as ImplementationMaterialRead | undefined,
        ),
        'agent_system_dispatch',
        modelInput,
      );
    }
    let request = input;
    if (input.action === 'retry') {
      const current = await this.scope(manifest, workspace);
      const record = nativeOperatorSelection(
        input,
        (await current.journal.read()).records,
        current.admitted.records,
        caller.sessionKey,
      );
      request = { action: 'retry', id: record.id };
    }
    if (input.action === 'recover') {
      const current = await this.scope(manifest, workspace);
      const record = await openClawEntryContext(
        {
          manifest,
          workspace,
          caller,
          action: input,
          operator,
          authority,
          dependencies: this.dependencies,
        },
        async (entry) =>
          nativeOperatorSelection(
            input,
            (await current.journal.read()).records,
            current.admitted.records,
            caller.sessionKey,
            entry,
          ),
      );
      const authored = { ...input };
      delete authored.target;
      delete authored.chat;
      delete authored.preview;
      request = { ...authored, id: record.id, apply: !input.preview };
    }
    if (input.action === 'retire') {
      if (!operator) throw new Error('dispatch-operator-required');
      await authority.assertCurrent?.();
      if (!input.preview)
        await reconcileOpenClawRetirementEffects({
          dependencies: this.dependencies,
          manifest,
          workspace,
        });
      const authored = { ...input };
      delete authored.target;
      delete authored.preview;
      request = { ...authored, apply: !input.preview };
      if (!input.native) {
        const current = await this.scope(manifest, workspace);
        const record = nativeOperatorSelection(
          input,
          (await current.journal.read()).records,
          current.admitted.records,
          caller.sessionKey,
        );
        request.id = record.id;
      }
    }
    if (isNativeDispatchSelection(input.action)) {
      const current = await this.scope(manifest, workspace);
      const record = nativeDispatchSelection(
        input,
        (await current.journal.read()).records,
        current.admitted.records,
        caller.sessionKey,
      );
      const authored = { ...input };
      delete authored.target;
      request = {
        ...authored,
        id: record.id,
        ...(input.action === 'prepare' ? { digest: nativeDispatchDigest(record, 'openclaw') } : {}),
      };
    }
    if (isNativeContextRequest('dispatch', input)) {
      assertNativeContextInput(input);
      const current = await this.scope(manifest, workspace);
      const owners = (await current.journal.read()).records.filter(
        (record) => record.threadId === caller.sessionKey,
      );
      if (owners.length > 1) throw new Error('native-context-owner-ambiguous');
      const owner = owners[0];
      if (!owner && input.action === 'feedback' && input.operation === 'reconcile') {
        const authored = { ...input };
        delete authored.source;
        request = {
          ...authored,
          ...nativeFeedbackReconciliation(
            (await current.journal.read()).records,
            current.admitted.records,
            caller.sessionKey,
            input.source,
          ),
        };
      } else {
        request = nativeContextRequest(input, owner);
      }
      if (owner && isNativeFeedbackRequest('dispatch', input)) {
        const admission = dispatchAdmission(owner!, current.admitted.records);
        const selected = input.source
          ? undefined
          : await this.dependencies.credential.use(authority, (request) =>
              resolveOpenClawTurnFeedback(owner, caller, request, this.dependencies.config()),
            );
        const event = nativeFeedbackSource(
          owner.feedback?.events ?? [],
          selected?.event.id,
          admission && `${admission.repository.owner.login}/${admission.repository.name}`,
          input.source,
        );
        const authored = { ...request };
        delete authored.source;
        request = { ...authored, eventId: event.id };
      }
    }
    let response = await this.run(
      manifest,
      workspace,
      caller,
      request as Static<typeof dispatchParameters>,
      operator,
      authority,
    );
    if (response && typeof response === 'object' && 'id' in response) {
      const current = await this.dependencies.intake.select(manifest, workspace, {
        resolvePolicy: false,
      });
      const journal = new OpenClawDispatchStore(
        this.dependencies.root,
        current.store.location.scope,
      );
      response = nativeDispatchResponse(
        response,
        (await journal.read()).records,
        (await current.store.read())?.records ?? [],
      );
    }
    return nativeMaterialResponse(
      nativeContextResponse(
        response,
        'dispatch',
        typeof input.source === 'string' ? input.source : undefined,
      ),
      'agent_system_dispatch',
      modelInput,
    );
  }
  run(...args: Parameters<OpenClawDispatch['runScoped']>) {
    return withDispatchTask('openclaw', args[2].sessionKey, () => this.runScoped(...args));
  }
  private async runScoped(
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
        (input.action === 'feedback' && input.operation === 'context') ||
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
      (input.action === 'implementation' && input.operation === 'context')
    ) {
      if (response.status === 'verified' && 'implementation' in response) {
        const request =
          input.action === 'implementation'
            ? {
                action: 'implementation',
                operation: 'context',
                ...(input.target ? { target: input.target } : {}),
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
    input: Extract<
      Static<typeof dispatchParameters>,
      {
        action: 'launch';
      }
    >,
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
          intakeStore: selected.store,
          ...(this.dependencies.claims
            ? { claim: (event, id) => this.dependencies.claims!.manual(event, client, id) }
            : {}),
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
    if (!('id' in admitted)) throw new Error('launch-owner-unavailable');
    const selected = await this.context.scope(manifest, workspace);
    const record = (await selected.journal.read()).records.find(
      (entry) => entry.id === admitted.id,
    );
    if (
      !record?.manualIssue ||
      record.sourceThreadId !== caller.sessionKey ||
      (admitted.status === 'existing' &&
        (!launchPending(record) || action.operation !== 'reconcile'))
    )
      return admitted;
    if (action.operation === 'prepare') {
      if (
        !action.assessment ||
        !action.title ||
        !('digest' in admitted) ||
        typeof admitted.digest !== 'string'
      )
        throw new Error('launch-preparation-required');
      const prepared = await this.execute(
        manifest,
        workspace,
        caller,
        {
          action: 'prepare',
          id: admitted.id,
          assessment: action.assessment,
          ...(action.fallback ? { fallback: action.fallback } : {}),
          title: action.title,
          digest: admitted.digest,
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
        { action: 'reconcile', id: admitted.id },
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
      { action: 'assess', id: admitted.id },
      true,
      authority,
    );
  }
  private async execute(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    input: Exclude<
      Static<typeof dispatchParameters>,
      {
        action: 'launch';
      }
    >,
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
              base: input.base,
            }
          : input.operation === 'context'
            ? { action: 'implementation-context', id, scope: input.scope, material: input.material }
            : input.operation === 'result' && input.result
              ? { action: 'implementation-result', id, implementationResult: input.result }
              : { action: 'implementation-context', id };
    }
    if (input.action === 'assessment' && input.operation === 'render') {
      if (caller.sessionKey) {
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
        apply: input.apply,
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
    if (input.action === 'delivery' && input.operation === 'present') {
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
    const childAction = input.action === 'context' || workAction || feedbackChild;
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
            !record.manualIssue &&
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
                  phase: dispatchCreationStatus(record),
                  workflowStatus: workflowStatus(record),
                  assignmentObservation: record.assignmentObservation,
                  assignmentWarning:
                    record.assignmentObservation &&
                    workflowRecovery(record.assignmentObservation.code),
                  threadId: record.threadId,
                  effective: record.effective,
                  sessionCreation: record.sessionCreation,
                  nativeTurns: record.nativeTurns?.map(({ role, turn }) => ({
                    role,
                    runId: turn.runId,
                    status: turn.status,
                    consumedByEventId: turn.consumedByEventId,
                    replyEventId: turn.replyEventId,
                    cancelled: turn.cancelled,
                    failed: turn.failed,
                  })),
                  blocker: record.blocker,
                  failureStage: record.failureStage,
                  retirement: record.retirement,
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
          if (record.retirement) throw new Error('dispatch-issue-inactive');
          if (record.request) throw new Error('dispatch-native-recovery-required');
          record.manifestDigest = current.manifestDigest;
          await this.validate(manifest, workspace, record);

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
            !nativeTurnFor(record, 'assessment'))
        )
          throw new Error('dispatch-assessment-caller-mismatch');
        const verified = await this.validate(
          manifest,
          workspace,
          record,
          workAction,
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
