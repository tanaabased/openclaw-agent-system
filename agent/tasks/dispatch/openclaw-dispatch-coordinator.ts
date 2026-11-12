import dispatchCreationStatus from './dispatch-creation-status.ts';
import { randomUUID } from 'node:crypto';
import { workflowFeedbackAccepting } from '../../../channels/github/feedback-policy.ts';
import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../../../channels/github/provider/work-item.ts';
import { stateSnapshotConflictCode } from '../../../core/merge-state-snapshot.ts';
import type { DispatchAuthority } from '../../../credentials/session-dispatch.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import { assignmentClaimRoute } from './assignment-claim-source.ts';
import { automationHash } from '../../automation-hash.ts';
import { announcementRecoveryAction } from '../delivery/delivery-announcement-recovery.ts';
import DiscoveryBudget from '../../discovery-budget.ts';
import discoveryCheckpoint from '../../discovery-checkpoint.ts';
import dispatchContext from './dispatch-context.ts';
import pendingAssignments, { issueKey } from './dispatch-pending.ts';
import { dispatchRetryDue, scheduleDispatchRetry } from './dispatch-retry.ts';
import { dispatchStoragePressure } from './dispatch-storage.ts';
import assertDormantAssignmentUnclaimed from './dormant-assignment-claim.ts';
import { observeFeedbackPolicy } from '../feedback/feedback-source.ts';
import intakePassStarted from '../../intake-pass-started.ts';
import issuePickupCapacity from '../../issue-pickup-capacity.ts';
import liveWorkflowPolicy from '../live-workflow-policy.ts';
import {
  dispatchAdmission,
  managedTargetUrl,
  type ManagedIssue as IntakeRecord,
} from '../managed-issue.ts';
import resolveModelRoutingRequest from '../../model-routing-request.ts';
import { assessmentSchema } from '../../model-routing.ts';
import recoverOpenClawAnnouncement from '../delivery/openclaw-announcement-recovery.ts';
import reconcileOpenClawLifecycle from './openclaw-assignment-lifecycle.ts';
import dispatchCapacity from './openclaw-capacity.ts';
import { openClawWorkSlot } from '../implementation/openclaw-continuation.ts';
import {
  openClawDispatchFailureCode,
  type default as OpenClawDispatchContext,
  type OpenClawDispatchTransaction,
} from './openclaw-dispatch-context.ts';
import type OpenClawDispatchIssue from './openclaw-dispatch-issue.ts';
import { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import {
  applyOpenClawFeedbackScans,
  scanOpenClawFeedback,
} from '../feedback/openclaw-feedback-scan.ts';
import { sameIntakeRun } from '../../openclaw-intake-pass.ts';
import openclawIntakeReport, { type IntakeObservation } from '../../openclaw-intake-report.ts';
import openClawNativeTurns, { nativeTurnFor } from '../../openclaw-native-turns.ts';
import openClawRoutingInstructions from '../../openclaw-routing-instructions.ts';
import observeIssueActivity from '../../openclaw-session-activity.ts';
import { verifyEmptyIssueSession, type DispatchCaller } from '../../openclaw-session-create.ts';
import {
  routingInstructionsDigest,
  routingInstructionsGuidance,
  routingInstructionsReference,
} from '../../routing-instructions.ts';
import taskPullRequest from '../delivery/task-pull-request.ts';
import workflowFailure from '../workflow-failure.ts';
import workflowRecovery from '../workflow-recovery.ts';
import workflowStatus from '../workflow-status.ts';
function source(intake: IntakeRecord) {
  return managedTargetUrl(intake);
}
function digest(record: OpenClawDispatchRecord) {
  return automationHash({
    context: record.context,
    manifest: record.manifestDigest,
    instructions:
      record.routingInstructions && routingInstructionsDigest(record.routingInstructions),
  });
}
function pendingAssignment({
  record,
  intake,
}: {
  record?: OpenClawDispatchRecord;
  intake: IntakeRecord;
}) {
  return !record || (!record.request && (!record.blocker || record.intakeId !== intake.id));
}
export default class OpenClawDispatchCoordinator {
  constructor(
    readonly context: OpenClawDispatchContext,
    readonly issue: Pick<OpenClawDispatchIssue, 'continueWork' | 'feedback'>,
    readonly validate: OpenClawDispatchContext['validate'],
  ) {}
  /** bounded private discovery; only saved actionable work or a progress notice wakes the model. */
  async check(
    manifest: AgentManifest,
    workspace: string,
    signal?: AbortSignal,
    observation?: IntakeObservation,
    selector?: GitHubNotificationItemSelector,
    budget = new DiscoveryBudget(20000, signal),
  ) {
    signal?.throwIfAborted();
    const startedAt = budget.clock();
    const reporting = await budget.read('report-scope', () =>
      this.context.reportScope(manifest, workspace),
    );
    const intake =
      observation ??
      (await this.context.dependencies.intake.run(
        manifest,
        workspace,
        'check',
        reporting.selected.digest,
        signal,
        undefined,
        budget.fork(7000),
      ));
    const assignmentAt = budget.clock();
    let lifecycleFailure: string | undefined;
    let diagnostic = intake.diagnostic;
    if (intake.status === 'ready') {
      if (selector) {
        const admitted = (await reporting.store.read())?.records ?? [];
        await reporting.journal.exclusive(
          async (state, save) => {
            let changed = false;
            for (const record of state.records) {
              const source = dispatchAdmission(record, admitted);
              if (!source || record.reset) continue;
              const repository = `${source.repository.owner.login}/${source.repository.name}`;
              const pr = taskPullRequest(record);
              const matches =
                githubNotificationItemMatchesSelector(
                  { itemType: 'issue', number: source.issue.number },
                  repository,
                  selector,
                ) ||
                (pr &&
                  githubNotificationItemMatchesSelector(
                    { itemType: 'pull-request', number: pr.pullRequestNumber },
                    repository,
                    selector,
                  ));
              if (matches && record.lifecycleCheckedAt !== undefined) {
                delete record.lifecycleCheckedAt;
                changed = true;
              }
            }
            if (changed) await save();
          },
          true,
          'dispatch-commit',
          budget.signal,
        );
      }
      // share the remaining time with feedback rather than letting lifecycle consume it all.
      const lifecycleBudget = budget.fork(budget.remaining / 2);
      try {
        await reconcileOpenClawLifecycle({
          service: this.context,
          manifest,
          workspace,
          authority: { signal: lifecycleBudget.signal },
          budget: lifecycleBudget,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (!lifecycleBudget.exhausted)
          lifecycleFailure = workflowFailure(error, 'dispatch-lifecycle-observation-failed').code;
        diagnostic = {
          phase: lifecycleBudget.operation,
          elapsedMs: Math.max(0, budget.clock() - startedAt),
          reason: lifecycleFailure ?? 'discovery-budget-exhausted',
        };
      }
      signal?.throwIfAborted();
    }
    const lifecycleAt = budget.clock();
    const state = await budget.read('dispatch-state', () => reporting.journal.read());
    const report = openclawIntakeReport({
      state,
      intake: await budget.read('intake-state', () => reporting.store.read()),
      slots: reporting.selected.policy.maxConcurrentItems,
      observation: intake,
      debug: manifest.debug,
    });
    const intakeFailure = intake.status !== 'ready' ? intake.code : undefined;
    const current = await budget.read('workspace-scope', () =>
      this.context.scope(manifest, workspace),
    );
    const sourceThreadId = await budget.read('coordinator-binding', () =>
      this.context.dependencies.coordinator(manifest, current.workspace),
    );
    const cycleAt = state.discoveryCycleAt ?? (this.context.dependencies.now ?? Date.now)();
    const previousCodes = new Map(
      state.records.map((record) => [record.id, record.feedback?.code]),
    );
    const scans = await scanOpenClawFeedback({
      service: {
        dependencies: this.context.dependencies,
        scope: (...args) => this.context.scope(...args),
        validate: this.validate,
      },
      state,
      manifest,
      workspace: current.workspace,
      sourceThreadId,
      authority: { signal: budget.signal },
      budget,
      now: (this.context.dependencies.now ?? Date.now)(),
      checkpoint: (scan) => discoveryCheckpoint(current.journal, scan, undefined, false),
    });
    applyOpenClawFeedbackScans(state.records, scans);
    const feedbackAt = budget.clock();
    const owners = state.records.filter(
      (r) => !r.retirement && !r.reset && r.sessionCreation?.verified && r.threadId,
    );
    const more = Boolean(
      ('more' in intake && intake.more) ||
      owners.some(
        (r) =>
          (r.feedback?.scannedTime ?? 0) < cycleAt ||
          r.feedback?.discoveryPending ||
          Object.keys(r.feedback?.discovery ?? {}).length > 0,
      ),
    );
    await current.journal.exclusive(
      async (fresh, save) => {
        fresh.discoveryCheckedAt = Date.now();
        fresh.discoveryTimings = {
          assignmentMs: Math.max(0, assignmentAt - startedAt),
          lifecycleMs: Math.max(0, lifecycleAt - assignmentAt),
          feedbackMs: Math.max(0, feedbackAt - lifecycleAt),
        };
        if (more) fresh.discoveryCycleAt = cycleAt;
        else delete fresh.discoveryCycleAt;
        if (more || fresh.discoveryProgress)
          fresh.discoveryProgress = {
            pending: more,
            sources: owners.length,
            ...(fresh.discoveryProgress?.pending === more
              ? { reported: fresh.discoveryProgress.reported }
              : {}),
          };
        state.discoveryProgress = fresh.discoveryProgress;
        await save();
      },
      false,
      'dispatch-commit',
    );
    const feedbackPending = state.records.some(
      (record) =>
        !record.reset &&
        !record.supersededBy &&
        record.feedback?.events.some(
          (event) =>
            (event.phase !== 'delivered' &&
              event.turn &&
              event.turn.status !== 'completed' &&
              !event.turn.inactive) ||
            ((!event.retry ||
              dispatchRetryDue(event, (this.context.dependencies.now ?? Date.now)())) &&
              event.phase === 'queued' &&
              !event.policyHeld),
        ),
    );
    const recoverable = state.records.some(
      (record) =>
        !record.retirement &&
        !record.reset &&
        (continuationStatus(record) ||
          (record.blocker &&
            dispatchRetryDue(
              record,
              (this.context.dependencies.now ?? Date.now)(),
              record.failureStage === 'worktree' && !record.request,
            ))),
    );
    const storagePaused = ['paused', 'emergency'].includes(dispatchStoragePressure(state).level);
    const pending = (storagePaused ? [] : pendingAssignments(state, current.admitted))
      .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
      .filter(pendingAssignment)
      .some(
        ({ intake }) =>
          dispatchCapacity(
            state,
            current.policy.policy.maxConcurrentItems,
            state.projectPickup,
            intake.evidence?.projectWork?.pickup?.issueNodeId,
          ).available > 0,
      );
    const announcementPending = state.records.some(
      (record) =>
        announcementRecoveryAction(record, (this.context.dependencies.now ?? Date.now)()) ===
        'check',
    );
    const workPending = state.records.some(
      (record) => !record.reset && !record.supersededBy && openClawWorkSlot(record),
    );
    const actionable =
      announcementPending || feedbackPending || recoverable || workPending || pending;
    const code =
      state.records.find((record) => !record.retirement && !record.reset && record.feedback?.code)
        ?.feedback?.code ??
      lifecycleFailure ??
      intakeFailure;
    return {
      status: 'ready' as const,
      ...(diagnostic || code || more
        ? {
            diagnostic: diagnostic ?? {
              phase: budget.operation,
              elapsedMs: Math.max(0, budget.clock() - startedAt),
              reason: code ?? 'discovery-incomplete',
            },
          }
        : {}),
      more,
      outcome: actionable ? 'actionable' : code ? 'failed' : more ? 'paused' : 'unchanged',
      ...(code ? { code } : {}),
      changed:
        report.changed ||
        scans.some((scan) => scan.feedback.code !== previousCodes.get(scan.id)) ||
        Boolean(
          state.discoveryProgress &&
          state.discoveryProgress.reported !== state.discoveryProgress.pending,
        ) ||
        actionable,
    };
  }
  async report(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    authority: DispatchAuthority,
  ) {
    authority.signal?.throwIfAborted();
    const current = await this.context.reportScope(manifest, workspace);
    if (
      caller.sessionKey !==
      (await this.context.dependencies.coordinator(manifest, current.workspace, true))
    )
      throw new Error('dispatch-intake-caller-required');
    const observation = await this.context.observe(manifest, workspace);
    const intake = await current.store.read();
    return current.journal.exclusive(async (state, save) => {
      if (state.intakeReport?.runId === caller.runId)
        return {
          status: 'reported' as const,
          response: state.intakeReport.response,
          instructions: 'Reproduce response unchanged. An empty response means no card.',
        };
      const report = openclawIntakeReport({
        state,
        intake,
        observation,
        slots: current.selected.policy.maxConcurrentItems,
      });
      const response = report.changed ? report.response : '';
      state.intakeReport = {
        fingerprint: report.fingerprint,
        problems: report.problems,
        runId: caller.runId,
        response,
      };
      for (const record of state.records)
        if (report.started.includes(record.id))
          record.intakeReportedAt = (this.context.dependencies.now ?? Date.now)();
      authority.signal?.throwIfAborted();
      await authority.assertCurrent?.();
      await save();
      return {
        status: 'reported' as const,
        response,
        instructions:
          'Reproduce response unchanged. An empty response means no card. This receipt records report preparation, not verified visible delivery.',
      };
    });
  }
  async next(tx: OpenClawDispatchTransaction) {
    const {
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
    } = tx;
    let policyObserved = false;
    for (const record of state.records) {
      if (record.reset || !record.feedback) continue;
      const enabled = record.feedback.admission?.enabled;
      const observedAt = record.feedback.admission?.observedAt;
      observeFeedbackPolicy(record.feedback, manifest.github?.notifications, now);
      policyObserved ||=
        enabled !== record.feedback.admission?.enabled ||
        observedAt !== record.feedback.admission?.observedAt;
    }
    if (policyObserved) await save();
    for (const record of state.records) {
      if (
        record.retirement ||
        record.reset ||
        record.handoff ||
        !record.blocker ||
        !dispatchRetryDue(record, now, record.failureStage === 'worktree' && !record.request)
      )
        continue;
      delete record.blocker;
    }
    const signal = authority.signal
      ? AbortSignal.any([authority.signal, transactionSignal])
      : transactionSignal;
    for (const { record, intake } of pendingAssignments(state, current.admitted).filter(
      ({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake),
    )) {
      if (
        !record?.request ||
        !record.sessionCreation?.attempted ||
        record.intakeId === intake.id ||
        nativeTurnFor(record, 'assessment')
      )
        continue;
      try {
        await this.context.validate(manifest, workspace, record);
      } catch (error) {
        if (openClawDispatchFailureCode(error) !== 'dispatch-assignment-superseded') {
          record.blocker = openClawDispatchFailureCode(error);
          scheduleDispatchRetry(record, record.blocker, error, now);

          await save();
          continue;
        }
        // supersession permits observation of the old intent, never another creation.
        record.blocker = 'dispatch-assignment-superseded';

        try {
          const sessionId = await this.context.dependencies.credential.use(
            { ...authority, signal },
            (request) =>
              verifyEmptyIssueSession(request, record, this.context.dependencies.config(), true),
          );
          record.sessionCreation.sessionId = sessionId;
          record.sessionCreation.verified = true;
          if ('key' in record.request) record.threadId = record.request.key;
        } catch (recoveryError) {
          record.blocker = openClawDispatchFailureCode(recoveryError);
        }
        await save();
      }
    }
    const unfinished = state.records.flatMap((record) =>
      (record.feedback?.events ?? [])
        .filter((event) => event.turn && !event.turn.inactive && event.phase !== 'delivered')
        .map((event) => ({ record, event })),
    );
    for (const entry of unfinished.slice(0, 12))
      await this.issue.feedback(
        manifest,
        current.workspace,
        entry.record,
        entry.event,
        caller,
        undefined,
        save,
        { ...authority, signal },
      );
    for (const owner of state.records) {
      const receipts = new Set([
        ...(owner.announcement?.receipt ? [owner.announcement.receipt.nodeId] : []),
      ]);
      for (const event of owner.feedback?.events ?? [])
        if (event.phase === 'queued' && !event.policyHeld && receipts.has(event.sourceId)) {
          event.phase = 'blocked';
          event.code = 'feedback-own-output';
        }
    }
    await save();
    const queued = state.records
      .filter((record) => !record.reset && !record.supersededBy)
      .flatMap((record) =>
        (record.feedback?.events ?? [])
          .filter(
            (event) =>
              event.phase === 'queued' &&
              !record.retirement &&
              !event.policyHeld &&
              (!event.retry || dispatchRetryDue(event, now)),
          )
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, 1)
          .map((event) => ({
            record,
            event,
            at: Math.max(event.createdAt, record.feedback?.lastServedAt ?? 0),
          })),
      )
      .sort((a, b) => a.at - b.at || a.event.id.localeCompare(b.event.id));
    // conversation delivery is independent of assignment admission and work recovery.
    let feedbackResult: Awaited<ReturnType<typeof this.issue.feedback>> | undefined;
    for (const { record, event } of queued.slice(0, 12)) {
      feedbackResult = await this.issue.feedback(
        manifest,
        current.workspace,
        record,
        event,
        caller,
        undefined,
        save,
        { ...authority, signal },
      );
    }
    for (const record of state.records
      .filter((entry) => !entry.retirement && announcementRecoveryAction(entry, now) === 'check')
      .slice(0, 12))
      await recoverOpenClawAnnouncement(this.context, manifest, current.workspace, record, save, {
        ...authority,
        signal,
        caller,
      });
    // Resolve finished native turns before freezing this pass's available slots.
    for (const record of state.records
      .filter(
        (entry) =>
          !entry.reset &&
          !entry.retirement &&
          !entry.supersededBy &&
          [
            ...openClawNativeTurns(entry).map(({ turn }) => (turn.inactive ? undefined : turn)),
          ].some((turn) => turn && turn.status !== 'completed'),
      )
      .slice(0, 12)) {
      await this.issue.continueWork(manifest, current.workspace, record, save, {
        ...authority,
        signal,
        caller,
      });
    }
    // Capacity follows native activity even when feedback scanning is disabled or unavailable.
    for (const record of state.records.filter(
      (entry) =>
        entry.sessionCreation?.verified &&
        entry.threadId &&
        !entry.reset &&
        !entry.supersededBy &&
        !entry.cleanupPending,
    )) {
      try {
        const activity = await this.context.dependencies.credential.use(
          { ...authority, signal },
          (request) => observeIssueActivity(request, record, this.context.dependencies.config()),
        );
        record.nativeInactive = !activity.busy;
      } catch {
        signal.throwIfAborted();
        // Unknown native custody conservatively retains its existing admission slot.
        record.nativeInactive = false;
      }
    }
    await save();
    const capacity = dispatchCapacity(
      state,
      current.policy.policy.maxConcurrentItems,
      state.projectPickup,
    );
    const assignments = pendingAssignments(state, current.admitted)
      .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
      .filter(pendingAssignment)
      .sort(
        (a, b) =>
          Date.parse(a.intake.assignment.createdAt) - Date.parse(b.intake.assignment.createdAt) ||
          issueKey(a.intake).localeCompare(issueKey(b.intake)),
      );
    let pass = state.openclawPasses?.find((entry) => sameIntakeRun(entry, caller));
    if (pass?.completed) return { status: 'pass-completed' as const };
    if (!pass) {
      pass = {
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        runId: caller.runId,
        limit: current.policy.policy.maxConcurrentItems,
        allowance: capacity.available + issuePickupCapacity(state.projectPickup),
        candidates: [
          ...assignments.map(({ intake }) => ({
            id: intake.id,
            at: Date.parse(intake.assignment.createdAt),
          })),
        ]
          .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
          .slice(0, 12)
          .map(({ id }) => id),
        recovery: state.records
          .filter((record) => continuationStatus(record))
          .slice(0, current.policy.policy.maxConcurrentItems)
          .map((record) => record.id),
        selected: [],
      };
      (state.openclawPasses ??= []).push(pass);
      await save();
      // Saving refreshes non-keyed arrays; use the retained pass from the new snapshot.
      pass = state.openclawPasses!.find((entry) => sameIntakeRun(entry, caller))!;
    }
    const continuing = state.records.find(
      (record) =>
        pass.recovery.includes(record.id) &&
        !pass.selected.includes(record.id) &&
        continuationStatus(record),
    );
    if (continuing) {
      if (feedbackResult) return feedbackResult;
      pass.selected.push(continuing.id);
      await save();
      return { status: continuationStatus(continuing)!, id: continuing.id };
    }
    const storagePaused = ['paused', 'emergency'].includes(dispatchStoragePressure(state).level);
    const pending = (storagePaused ? [] : pendingAssignments(state, current.admitted))
      .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
      .filter(pendingAssignment)
      .filter(
        ({ intake, record }) =>
          pass.candidates.includes(intake.id) &&
          (!record || !pass.selected.includes(record.id)) &&
          dispatchCapacity(
            state,
            current.policy.policy.maxConcurrentItems,
            state.projectPickup,
            intake.evidence?.projectWork?.pickup?.issueNodeId,
          ).available > 0,
      )
      .sort(
        (a, b) => pass.candidates.indexOf(a.intake.id) - pass.candidates.indexOf(b.intake.id),
      )[0];
    const started = intakePassStarted(pass, state.records).length;
    if (started >= pass.allowance)
      return { status: pass.selected.length ? 'pass-completed' : 'at-capacity' };
    if (!pending && !capacity.available && !pass.selected.length)
      return { status: 'at-capacity' as const };
    if (!pending)
      return {
        ...(storagePaused ? { code: 'dispatch-storage-admission-paused' } : {}),
        status: storagePaused
          ? 'at-capacity'
          : pass.selected.length ||
              pendingAssignments(state, current.admitted)
                .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
                .some(pendingAssignment)
            ? 'pass-completed'
            : 'idle',
      };
    const record: OpenClawDispatchRecord = pending.record ?? {
      id: automationHash([current.journal.scope, randomUUID()]),
      intakeId: pending.intake.id,
      ...(!('initiation' in pending.intake) && pending.intake.evidence.projectWork
        ? { projectWork: structuredClone(pending.intake.evidence.projectWork) }
        : {}),
      issueKey: issueKey(pending.intake),
      sourceThreadId,

      createdAt: now,
      manifestDigest: current.manifestDigest,
      feedback: {
        startedAt: now,
        admission: {
          observedAt: now,
          enabled: workflowFeedbackAccepting(manifest.github?.notifications, 'issue-assignment'),
        },
        baseline: {},
        events: [],
      },
    };
    if (!pending.record) state.records.push(record);
    pass.selected.push(record.id);
    record.intakeId = pending.intake.id;
    record.manifestDigest = current.manifestDigest;

    delete record.blocker;
    delete record.failureStage;
    try {
      await save();
      if ((await current.store.consume(pending.intake, record.id)) !== record.id)
        throw new Error('dispatch-assignment-consumed');
      const { client, repo, intake } = await this.context.validate(manifest, workspace, record);
      if ('initiation' in intake) throw new Error('dispatch-assignment-required');
      const route = assignmentClaimRoute(current.policy.policy, intake);
      if (!this.context.dependencies.claims) {
        await assertDormantAssignmentUnclaimed(this.context.dependencies.claimStore, intake);
        if (route.decision === 'swarm') throw new Error('claim-runtime-unavailable');
      }
      const claim = await this.context.dependencies.claims?.select({
        intake,
        mode: route.decision,
        eligibleInstanceIds: route.eligibleInstanceIds,
        client,
        caller,
        hasCapacity: capacity.available > 0,
      });
      if (claim && claim.status !== 'owned' && claim.status !== 'local') {
        if (claim.status === 'recovery-required') throw new Error(claim.code);
        await save();
        return {
          status: 'claim-waiting' as const,
          id: record.id,
          claim,
          nextAction: 'next' as const,
        };
      }
      if (claim?.status === 'owned') record.claimId = claim.winnerId;
      const evidence = await client.getItemContext(
        repo.owner.login,
        repo.name,
        intake.issue.number,
        'issue',
        true,
        false,
        true,
      );
      record.context = JSON.stringify(dispatchContext(evidence, source(intake), now));
      record.routingInstructions = await openClawRoutingInstructions(this.context, tx);
      await save();
      return {
        status: 'routing-required' as const,
        id: record.id,
        digest: digest(record),
        context: JSON.parse(record.context),
        assessmentSchema,
        routing: {
          ...resolveModelRoutingRequest(
            manifest.models,
            current.manifestDigest,
            { action: 'inspect' },
            'openclaw',
          ),
          instructions: routingInstructionsReference(record.routingInstructions),
          instructionsDigest: routingInstructionsDigest(record.routingInstructions),
          instructionsGuidance: routingInstructionsGuidance,
        },
      };
    } catch (error) {
      if (openClawDispatchFailureCode(error) === stateSnapshotConflictCode) throw error;
      record.blocker = openClawDispatchFailureCode(error);
      scheduleDispatchRetry(record, record.blocker, error, now);

      await save();
      return {
        status: dispatchCreationStatus(record),
        id: record.id,
        ...workflowFailure(error, record.blocker),
        workflowStatus: workflowStatus(record),
        assignmentObservation: record.assignmentObservation,
        assignmentWarning:
          record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
        nextAction: 'next',
      };
    }
  }
}
function continuationStatus(record: OpenClawDispatchRecord) {
  if (
    !record.sessionCreation ||
    record.retirement ||
    record.feedbackReactivation ||
    record.handoff ||
    record.reset
  )
    return;
  // only the accepted receipt gap is automatically recoverable, and never by another send.
  if (
    ['blocked', 'waiting'].includes(dispatchCreationStatus(record)) &&
    record.failureStage === 'assessment-turn' &&
    record.blocker === 'dispatch-turn-delivery-unverified' &&
    nativeTurnFor(record, 'assessment') &&
    ['accepted', 'consumed'].includes(nativeTurnFor(record, 'assessment')!.status)
  )
    return 'reconcile-required';
  if (record.blocker) return;
  if (nativeTurnFor(record, 'assessment'))
    return record.nativeTurns?.some(({ turn }) => turn.status !== 'completed' && !turn.inactive)
      ? 'reconcile-required'
      : undefined;
  if (dispatchCreationStatus(record) === 'creating') return 'reconcile-required';
  if (dispatchCreationStatus(record) === 'created') return 'assessment-required';
}
