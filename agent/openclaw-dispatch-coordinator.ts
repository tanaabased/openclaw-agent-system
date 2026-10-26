import openClawRoutingInstructions from './openclaw-routing-instructions.ts';
import { routingInstructionsGuidance, routingInstructionsDigest } from './routing-instructions.ts';
import { dispatchAdmission, type ManagedIssue as IntakeRecord } from './managed-issue.ts';
import assertDormantAssignmentUnclaimed from './dormant-assignment-claim.ts';
import { openClawResponseEligible } from './openclaw-response-continuation.ts';
import { randomUUID } from 'node:crypto';

import { workflowFeedbackAccepting } from '../channels/github/feedback-policy.ts';
import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../channels/github/provider/work-item.ts';
import { stateSnapshotConflictCode } from '../core/merge-state-snapshot.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { automationHash } from './automation-hash.ts';
import DiscoveryBudget from './discovery-budget.ts';
import discoveryCheckpoint from './discovery-checkpoint.ts';
import dispatchContext from './dispatch-context.ts';
import pendingAssignments, { issueKey } from './dispatch-pending.ts';
import { dispatchFailurePhase, dispatchRetryDue, scheduleDispatchRetry } from './dispatch-retry.ts';
import { observeFeedbackPolicy } from './feedback-source.ts';
import liveWorkflowPolicy from './live-workflow-policy.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import { assessmentSchema } from './model-routing.ts';
import reconcileOpenClawLifecycle from './openclaw-assignment-lifecycle.ts';
import { openClawDecisionPending } from './openclaw-auto-decision.ts';
import dispatchCapacity, { openClawItemOccupied } from './openclaw-capacity.ts';
import { openClawWorkSlot } from './openclaw-continuation.ts';
import {
  type default as OpenClawDispatchContext,
  openClawDispatchFailureCode,
  type OpenClawDispatchTransaction,
} from './openclaw-dispatch-context.ts';

import type OpenClawDispatchIssue from './openclaw-dispatch-issue.ts';
import { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { applyOpenClawFeedbackScans, scanOpenClawFeedback } from './openclaw-feedback-scan.ts';
import { sameIntakeRun } from './openclaw-intake-pass.ts';
import intakeDebug from './intake-debug.ts';
import openclawIntakeReport, { type IntakeObservation } from './openclaw-intake-report.ts';
import { verifyEmptyIssueSession, type DispatchCaller } from './openclaw-session-create.ts';
import workflowFailure from './workflow-failure.ts';
import workflowRecovery from './workflow-recovery.ts';
import workflowStatus from './workflow-status.ts';

function source(intake: IntakeRecord) {
  return `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`;
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
  ) {
    const budget = new DiscoveryBudget(20000, signal);
    const reporting = await this.context.reportScope(manifest, workspace);
    const intake =
      observation ??
      (await this.context.dependencies.intake.run(
        manifest,
        workspace,
        'check',
        reporting.selected.digest,
        signal,
        undefined,
        new DiscoveryBudget(7000, budget.signal),
      ));
    if (intake.status === 'ready') {
      if (selector) {
        const admitted = (await reporting.store.read())?.records ?? [];
        await reporting.journal.exclusive(async (state, save) => {
          let changed = false;
          for (const record of state.records) {
            const source = dispatchAdmission(record, admitted);
            if (!source || record.retired || record.reset) continue;
            const repository = `${source.repository.owner.login}/${source.repository.name}`;
            const pr = record.work?.delivery?.pullRequest;
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
        });
      }
      await reconcileOpenClawLifecycle({
        service: this.context,
        manifest,
        workspace,
        authority: { signal: budget.signal },
      });
    }
    const state = await reporting.journal.read();
    const report = openclawIntakeReport({
      state,
      intake: await reporting.store.read(),
      slots: reporting.selected.policy.maxConcurrentItems,
      observation: intake,
      debug: manifest.debug,
    });
    if (intake.status !== 'ready' && intake.code !== 'intake-search-incomplete')
      return {
        status: 'ready' as const,
        changed: report.changed,
        outcome: 'failed',
        code: intake.code,
      };
    const current = await this.context.scope(manifest, workspace);
    const sourceThreadId = await this.context.dependencies.coordinator(manifest, current.workspace);
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
      checkpoint: (scan) => discoveryCheckpoint(current.journal, scan),
    });
    applyOpenClawFeedbackScans(state.records, scans);
    const owners = state.records.filter(
      (r) => !r.retired && !r.retirement && !r.reset && r.sessionCreation?.verified && r.threadId,
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
    await current.journal.exclusive(async (fresh, save) => {
      fresh.discoveryCheckedAt = Date.now();
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
    });
    const capacity = dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems);
    const feedbackPending = state.records.some(
      (record) =>
        !record.retired &&
        !record.retirement &&
        !record.reset &&
        record.feedback?.events.some(
          (event) =>
            ((!event.retry ||
              dispatchRetryDue(event, (this.context.dependencies.now ?? Date.now)())) &&
              event.phase !== 'blocked' &&
              ((event.turn && (event.phase !== 'published' || event.turn.status !== 'completed')) ||
                (event.publicationAttempted && !event.receipt))) ||
            (event.phase === 'queued' &&
              !event.policyHeld &&
              (!event.retry ||
                dispatchRetryDue(event, (this.context.dependencies.now ?? Date.now)())) &&
              !openClawItemOccupied(record) &&
              capacity.available > 0),
        ),
    );
    const recoverable = state.records.some(
      (record) =>
        !record.retired &&
        !record.retirement &&
        !record.reset &&
        (continuationStatus(record) ||
          (record.blocker &&
            dispatchRetryDue(record, (this.context.dependencies.now ?? Date.now)()))),
    );
    const pending = pendingAssignments(state, current.admitted)
      .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
      .some(pendingAssignment);
    const workPending = state.records.some(
      (record) =>
        (openClawDecisionPending(
          record,
          record.manualIssue?.selections?.mode ??
            manifest.github?.notifications?.issueAssignment?.mode ??
            'auto',
        ) ||
          openClawWorkSlot(
            record,
            record.manualIssue?.selections?.mode ??
              manifest.github?.notifications?.issueAssignment?.mode ??
              'auto',
          )) &&
        (openClawItemOccupied(record) || capacity.available > 0),
    );
    const responsePending = state.records.some((record) => openClawResponseEligible(record));
    const actionable =
      responsePending ||
      feedbackPending ||
      recoverable ||
      workPending ||
      (capacity.available > 0 && pending);
    const code = state.records.find(
      (record) => !record.retired && !record.retirement && !record.reset && record.feedback?.code,
    )?.feedback?.code;
    return {
      status: 'ready' as const,
      more,
      outcome: code ? 'failed' : actionable ? 'actionable' : more ? 'paused' : 'unchanged',
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
      const present = (response: string) => {
        if (!response) return '';
        const diagnostic = intakeDebug(manifest.debug, state.records, (record) => {
          const item = intake?.records.find((entry) => entry.id === record.intakeId);
          return item
            ? item.repository.owner.login + '/' + item.repository.name + '#' + item.issue.number
            : 'Issue';
        });
        return [response, diagnostic].filter(Boolean).join('\n\n');
      };
      if (state.intakeReport?.runId === caller.runId && state.intakeReport.reportVersion === 1)
        return {
          status: 'reported' as const,
          response: present(state.intakeReport.response),
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
        reportVersion: 1,
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
        response: present(response),
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
      if (record.retired || record.reset || !record.feedback) continue;
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
        record.retired ||
        record.retirement ||
        record.reset ||
        record.handoff ||
        !record.blocker ||
        !dispatchRetryDue(record, now)
      )
        continue;
      delete record.blocker;
      record.phase = record.assessmentTurn
        ? 'assessing'
        : record.sessionCreation?.verified
          ? 'created'
          : record.request
            ? 'creating'
            : 'routing';
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
        record.firstTurn ||
        record.assessmentTurn
      )
        continue;
      try {
        await this.context.validate(manifest, workspace, record);
      } catch (error) {
        if (openClawDispatchFailureCode(error) !== 'dispatch-assignment-superseded') {
          record.blocker = openClawDispatchFailureCode(error);
          scheduleDispatchRetry(record, record.blocker, error, now);
          record.phase = dispatchFailurePhase(record, record.blocker, error);
          await save();
          continue;
        }
        // supersession permits observation of the old intent, never another creation.
        record.blocker = 'dispatch-assignment-superseded';
        record.phase = 'blocked';
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
        .filter(
          (event) =>
            event.phase !== 'blocked' &&
            event.turn &&
            (event.phase !== 'published' || event.turn.status !== 'completed'),
        )
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
        ...(owner.feedback?.events.flatMap((event) =>
          event.receipt ? [event.receipt.nodeId] : [],
        ) ?? []),
        ...(owner.work?.delivery?.announcement?.receipt
          ? [owner.work.delivery.announcement.receipt.nodeId]
          : []),
      ]);
      for (const event of owner.feedback?.events ?? [])
        if (event.phase === 'queued' && !event.policyHeld && receipts.has(event.sourceId)) {
          event.phase = 'blocked';
          event.code = 'feedback-own-output';
        }
    }
    await save();
    // Resolve finished native turns before freezing this pass's available slots.
    for (const record of state.records
      .filter(
        (entry) =>
          !entry.retired &&
          !entry.retirement &&
          !entry.reset &&
          (!entry.work?.code || entry.work.code === 'dispatch-turn-failed') &&
          [
            entry.decisionTurn?.inactive ? undefined : entry.decisionTurn,
            entry.work?.turn,
            entry.work?.deliveryTurn,
            entry.summaryRecovery?.turn,
          ].some((turn) => turn && turn.status !== 'completed'),
      )
      .slice(0, 12)) {
      const reconciled = await this.issue.continueWork(
        manifest,
        current.workspace,
        record,
        save,
        { ...authority, signal },
        true,
      );
      if (
        record.decisionTurn?.inactive ||
        (record.work?.code &&
          ![
            'implementation-result-missing',
            'implementation-delivery-incomplete',
            'dispatch-turn-failed',
          ].includes(record.work.code))
      )
        return reconciled;
    }
    const capacity = dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems);
    const assignments = pendingAssignments(state, current.admitted)
      .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
      .filter(pendingAssignment)
      .sort(
        (a, b) =>
          Date.parse(a.intake.assignment.createdAt) - Date.parse(b.intake.assignment.createdAt) ||
          issueKey(a.intake).localeCompare(issueKey(b.intake)),
      );
    const queued = state.records
      .filter(
        (record) =>
          !record.retired &&
          !record.retirement &&
          !record.reset &&
          !record.feedback?.code &&
          !openClawItemOccupied(record),
      )
      .flatMap((record) =>
        (record.feedback?.events ?? [])
          .filter((event) => event.phase === 'queued' && !event.policyHeld)
          .sort((a, b) => a.createdAt - b.createdAt)
          .slice(0, 1)
          .map((event) => ({
            record,
            event,
            at: Math.max(event.createdAt, record.feedback?.lastServedAt ?? 0),
          })),
      )
      .sort((a, b) => a.at - b.at || a.event.id.localeCompare(b.event.id));
    const workItems = state.records
      .flatMap((record) => {
        const slot = openClawWorkSlot(
          record,
          record.manualIssue?.selections?.mode ??
            manifest.github?.notifications?.issueAssignment?.mode ??
            'auto',
        );
        const decision = openClawDecisionPending(
          record,
          record.manualIssue?.selections?.mode ??
            manifest.github?.notifications?.issueAssignment?.mode ??
            'auto',
        );
        return slot || decision || openClawResponseEligible(record)
          ? [
              {
                record,
                slot,
                candidateId: automationHash({ implementation: record.id }),
                recovering: Boolean(
                  (record.summaryRecovery && record.summaryRecovery.turn.status !== 'completed') ||
                  (decision
                    ? record.decisionTurn
                    : slot && record.work?.[slot] && record.work[slot].status !== 'completed'),
                ),
              },
            ]
          : [];
      })
      .sort(
        (a, b) =>
          a.record.createdAt - b.record.createdAt || a.candidateId.localeCompare(b.candidateId),
      );
    let pass = state.openclawPasses?.find((entry) => sameIntakeRun(entry, caller));
    if (!pass) {
      pass = {
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        runId: caller.runId,
        limit: current.policy.policy.maxConcurrentItems,
        allowance: capacity.available,
        candidates: [
          ...assignments.map(({ intake }) => ({
            id: intake.id,
            at: Date.parse(intake.assignment.createdAt),
          })),
          ...queued.map(({ event, at }) => ({ id: event.id, at })),
          ...workItems
            .filter((item) => !item.recovering)
            .map(({ record, candidateId }) => ({
              id: candidateId,
              at: record.createdAt,
            })),
        ]
          .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
          .slice(0, 12)
          .map(({ id }) => id),
        recovery: state.records
          .filter(
            (record) =>
              continuationStatus(record) ||
              workItems.some((item) => item.record.id === record.id && item.recovering),
          )
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
        (continuationStatus(record) ||
          workItems.some((item) => item.record.id === record.id && item.recovering)),
    );
    if (continuing) {
      pass.selected.push(continuing.id);
      await save();
      if (workItems.some((item) => item.record.id === continuing.id && item.recovering))
        return this.issue.continueWork(manifest, current.workspace, continuing, save, {
          ...authority,
          signal,
        });
      return { status: continuationStatus(continuing)!, id: continuing.id };
    }
    const pending = pendingAssignments(state, current.admitted)
      .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
      .filter(pendingAssignment)
      .filter(
        ({ intake, record }) =>
          pass.candidates.includes(intake.id) && (!record || !pass.selected.includes(record.id)),
      )
      .sort(
        (a, b) => pass.candidates.indexOf(a.intake.id) - pass.candidates.indexOf(b.intake.id),
      )[0];
    const started = pass.selected.filter(
      (id) =>
        !pass.recovery.includes(id) &&
        state.records.some(
          (record) =>
            record.id === id &&
            ((record.work &&
              pass.candidates.includes(automationHash({ implementation: record.id }))) ||
              (record.request &&
                pass.candidates.includes(record.intakeId ?? record.manualIssue!.id)) ||
              record.feedback?.events.some(
                (event) => pass.candidates.includes(event.id) && event.turn,
              )),
        ),
    ).length;
    if (started >= pass.allowance)
      return { status: pass.selected.length ? 'pass-completed' : 'at-capacity' };
    const feedback = queued.find(
      ({ record, event }) =>
        pass.candidates.includes(event.id) && !pass.selected.includes(record.id),
    );
    if (!capacity.available && (pending || feedback || !pass.selected.length))
      return { status: 'at-capacity' as const };
    const workItem = workItems.find(
      (item) =>
        !item.recovering &&
        pass.candidates.includes(item.candidateId) &&
        !pass.selected.includes(item.record.id),
    );
    if (
      workItem &&
      capacity.available > 0 &&
      (!pending ||
        pass.candidates.indexOf(workItem.candidateId) <
          pass.candidates.indexOf(pending.intake.id)) &&
      (!feedback ||
        pass.candidates.indexOf(workItem.candidateId) < pass.candidates.indexOf(feedback.event.id))
    ) {
      pass.selected.push(workItem.record.id);
      await save();
      return this.issue.continueWork(manifest, current.workspace, workItem.record, save, {
        ...authority,
        signal,
      });
    }
    if (
      feedback &&
      (!pending ||
        pass.candidates.indexOf(feedback.event.id) < pass.candidates.indexOf(pending.intake.id))
    ) {
      pass.selected.push(feedback.record.id);
      await save();
      return this.issue.feedback(
        manifest,
        current.workspace,
        feedback.record,
        feedback.event,
        caller,
        undefined,
        save,
        { ...authority, signal },
      );
    }
    if (!pending)
      return {
        status:
          pass.selected.length ||
          pendingAssignments(state, current.admitted)
            .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
            .some(pendingAssignment)
            ? 'pass-completed'
            : 'idle',
      };
    const record: OpenClawDispatchRecord = pending.record ?? {
      id: automationHash([current.journal.scope, randomUUID()]),
      intakeId: pending.intake.id,
      issueKey: issueKey(pending.intake),
      sourceThreadId,
      phase: 'routing',
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
    record.phase = 'routing';
    delete record.blocker;
    delete record.failureStage;
    try {
      const { client, repo, intake } = await this.context.validate(manifest, workspace, record);
      if ('initiation' in intake) throw new Error('dispatch-assignment-required');
      if (!this.context.dependencies.claims)
        await assertDormantAssignmentUnclaimed(this.context.dependencies.claimStore, intake);
      const claim = await this.context.dependencies.claims?.select({
        intake,
        client,
        caller,
        hasCapacity: capacity.available > 0,
      });
      if (claim && claim.status !== 'owned') {
        if (claim.status === 'recovery-required') throw new Error(claim.code);
        await save();
        return {
          status: 'claim-waiting' as const,
          id: record.id,
          claim,
          nextAction: 'next' as const,
        };
      }
      if (claim) record.claimId = claim.winnerId;
      const evidence = await client.getItemContext(
        repo.owner.login,
        repo.name,
        intake.issue.number,
        'issue',
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
          instructions: record.routingInstructions,
          instructionsDigest: routingInstructionsDigest(record.routingInstructions),
          instructionsGuidance: routingInstructionsGuidance,
        },
      };
    } catch (error) {
      if (openClawDispatchFailureCode(error) === stateSnapshotConflictCode) throw error;
      record.blocker = openClawDispatchFailureCode(error);
      scheduleDispatchRetry(record, record.blocker, error, now);
      record.phase = dispatchFailurePhase(record, record.blocker, error);
      await save();
      return {
        status: record.phase,
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
    record.retired ||
    record.retirement ||
    record.feedbackReactivation ||
    record.handoff ||
    record.reset
  )
    return;
  // only the accepted receipt gap is automatically recoverable, and never by another send.
  if (
    ['blocked', 'waiting'].includes(record.phase) &&
    record.failureStage === 'first-turn' &&
    record.blocker === 'dispatch-turn-delivery-unverified' &&
    record.sessionCreation.verified &&
    record.firstTurn &&
    ['accepted', 'consumed'].includes(record.firstTurn.status)
  )
    return 'reconcile-required';
  if (
    ['blocked', 'waiting'].includes(record.phase) &&
    record.failureStage === 'assessment-turn' &&
    record.blocker === 'dispatch-turn-delivery-unverified' &&
    record.assessmentTurn &&
    ['accepted', 'consumed'].includes(record.assessmentTurn.status)
  )
    return 'reconcile-required';
  if (record.blocker) return;
  if (record.assessmentTurn)
    return record.assessmentTurn.status !== 'completed' ? 'reconcile-required' : undefined;
  if (record.phase === 'creating') return 'reconcile-required';
  if (record.phase === 'created')
    return record.firstTurn && record.firstTurn.status !== 'completed'
      ? 'reconcile-required'
      : 'assessment-required';
}
