import advanceOpenClawDecision, { openClawDecisionPending } from './openclaw-auto-decision.ts';
import advanceOpenClawWork, { openClawWorkSlot } from './openclaw-continuation.ts';
import issueProgression from './issue-progression.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import { observeFeedbackPolicy } from './feedback-source.ts';
import { workflowFeedbackEnabled } from '../channels/github/feedback-policy.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { GitHubIssueDeliveryError } from '../channels/github/publication/issue-delivery.ts';
import reconcileOpenClawLifecycle from './openclaw-assignment-lifecycle.ts';
import workflowStatus from './workflow-status.ts';
import workflowFailure from './workflow-failure.ts';
import { dispatchFailurePhase, dispatchRetryDue, scheduleDispatchRetry } from './dispatch-retry.ts';
import assessmentSummary from './assessment-summary.ts';
import assessmentPresentation from './dispatch-presentation.ts';
import selectFeedbackStage from './feedback-stage.ts';
import openClawSkill from './openclaw-skill.ts';
import redactFeedback from './feedback-redaction.ts';
import { GitHubAccountClientError } from '../core/github-account-client.ts';
import { stateSnapshotConflictCode } from '../core/merge-state-snapshot.ts';
import discoveryCheckpoint from './discovery-checkpoint.ts';
import discoveryNotice from './discovery-notice.ts';
import DiscoveryBudget from './discovery-budget.ts';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import type { Static } from 'typebox';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import openclawTurnContext from './openclaw-turn-context.ts';
import openclawIntakeReport, { type IntakeObservation } from './openclaw-intake-report.ts';
import { issueAssessmentAction, selectOpenClawAssessment } from './openclaw-assessment.ts';
import createIssueSession, {
  IssueSessionMismatchError,
  verifyEmptyIssueSession,
  describeIssueSession,
  type DispatchCaller,
} from './openclaw-session-create.ts';
import advanceIssueTurn from './openclaw-session-turn.ts';
import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';

import { automationHash } from './automation-hash.ts';
import {
  githubNotificationItemMatchesSelector,
  type GitHubNotificationItemSelector,
} from '../channels/github/provider/work-item.ts';
import { sameIntakeRun } from './openclaw-intake-pass.ts';
import dispatchCapacity, { openClawItemOccupied } from './openclaw-capacity.ts';
import openClawFeedback, {
  advanceFeedbackTurn,
  authorizeFeedback,
  type OpenClawFeedbackAction,
  type OpenClawFeedbackProvider,
} from './openclaw-feedback.ts';
import {
  scanOpenClawFeedback,
  applyOpenClawFeedbackScans,
  openClawFeedbackEnabled,
} from './openclaw-feedback-scan.ts';
import type { OpenClawFeedbackEvent } from './openclaw-feedback-state.ts';
import feedbackResponse from '../channels/github/presentation/feedback-response.ts';
import dispatchContext from './dispatch-context.ts';
import pendingAssignments, { issueKey } from './dispatch-pending.ts';
import { inspectActiveIssue, inspectAdmittedIssue } from './dispatch-assignment.ts';
import retainedIntakePolicy from './retained-intake-policy.ts';
import { revalidateFeedbackAssignment } from './assignment-feedback-reactivation.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import { assessmentSchema } from './model-routing.ts';
import OpenClawDispatchStore, {
  preserveOpenClawProgress,
  type OpenClawDispatchRecord,
} from './openclaw-dispatch-state.ts';
import type OpenClawIntake from './openclaw-intake.ts';
import { IntakeError, type IntakeRecord } from '../channels/github/intake/record-store.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { GitHubNotificationCommentPublisherError } from '../channels/github/publication/comment-publisher.ts';
import { GitHubNotificationPublicationError } from '../channels/github/publication/publication-contract.ts';
import AgentSystemToolError from '../api/error.ts';
import {
  privateStateFileLockBusyErrorCode,
  privateStateFileLockLostErrorCode,
} from '../core/private-state-file-lock.ts';
import GitCommandError from '../tools/git/command-error.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type TrustedGitWorktreeService from '../tools/git/trusted-worktree-service.ts';
import type { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import openClawWorkAction, { verifyOpenClawWork } from './openclaw-work.ts';
import openClawDelivery, {
  presentOpenClawDelivery,
  type OpenClawDeliveryConnection,
} from './openclaw-delivery.ts';

export interface OpenClawDispatchDependencies {
  root: string;
  config(): OpenClawConfig;
  intake: OpenClawIntake;
  connect(
    input: { manifest: AgentManifest; workspaceDir: string },
    signal: AbortSignal,
  ): Promise<GitHubNotificationIntakeClient & GitHubNotificationItemContextClient>;
  worktrees: Pick<TrustedGitWorktreeService, 'prepareGitHub' | 'inspectGitHub'> &
    Partial<Pick<TrustedGitWorktreeService, 'cleanupGitHub'>>;
  coordinator(
    manifest: AgentManifest,
    workspace: string,
    presentationOnly?: boolean,
  ): Promise<string>;
  credential: Pick<SessionDispatchCredential, 'use'>;
  now?: () => number;
  feedbackConnect?(
    input: { manifest: AgentManifest; workspaceDir: string },
    signal: AbortSignal,
    connection?: GitHubNotificationIntakeClient & GitHubNotificationItemContextClient,
  ): Promise<OpenClawFeedbackProvider>;
  delivery?(input: {
    manifest: AgentManifest;
    workspaceDir: string;
    worktree: string;
    caller: DispatchCaller;
    signal: AbortSignal;
    connection?: GitHubNotificationIntakeClient & GitHubNotificationItemContextClient;
  }): Promise<OpenClawDeliveryConnection>;
}

function source(intake: IntakeRecord) {
  return `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`;
}
function digest(record: OpenClawDispatchRecord) {
  return automationHash({ context: record.context, manifest: record.manifestDigest });
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
export function openClawDispatchFailureCode(error: unknown): string {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  if (
    code === privateStateFileLockBusyErrorCode ||
    code === privateStateFileLockLostErrorCode ||
    code === stateSnapshotConflictCode
  )
    return code;
  if (error instanceof IntakeError && /^[a-z][a-z0-9-]{0,127}$/.test(error.code)) return error.code;
  if (error instanceof GitCommandError) return error.diagnosticCode;
  if (error instanceof AgentSystemToolError) {
    if (error.cause instanceof GitCommandError) return error.cause.diagnosticCode;
    return `dispatch-tool-${error.code.replaceAll('_', '-')}`;
  }
  if (
    error instanceof GitHubIssueDeliveryError ||
    error instanceof GitHubAccountClientError ||
    error instanceof GitHubWorkEventClientError ||
    error instanceof GitHubNotificationCommentPublisherError ||
    error instanceof GitHubNotificationPublicationError
  )
    return error.code;
  return error instanceof Error && /^[a-z][a-z0-9-]{2,127}$/.test(error.message)
    ? error.message
    : 'dispatch-operation-failed';
}

/** the coordinator supplies routing judgment; intake and session effects stay host-verified. */
export default class OpenClawDispatch {
  constructor(readonly dependencies: OpenClawDispatchDependencies) {}

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

  async scope(manifest: AgentManifest, workspace: string) {
    const current = await this.dependencies.intake.select(manifest, workspace);
    const admitted = await current.store.read();
    if (!admitted) throw new Error('dispatch-intake-activation-required');
    const selected = current.selected ?? retainedIntakePolicy(manifest, admitted, 'openclaw');
    return {
      ...current,
      admitted,
      policy: selected,
      manifestDigest: automationHash({ policy: selected.digest, models: manifest.models }),
      journal: new OpenClawDispatchStore(this.dependencies.root, current.store.location.scope),
    };
  }

  /** Local custody checks stay cheap enough to run before every native operation. */
  private async validateLocal(
    manifest: AgentManifest,
    workspace: string,
    record: OpenClawDispatchRecord,
    work = false,
    feedback = false,
  ) {
    const current = await this.scope(manifest, workspace);
    const fresh = await this.dependencies.intake.dependencies.manifestService.loadForAgentId(
      manifest.agent.id,
      'service',
    );
    if (fresh.status !== 'loaded') throw new Error('dispatch-manifest-unavailable');
    if (
      fresh.scope.workspaceDir !== current.workspace ||
      fresh.manifest.agent.id !== manifest.agent.id
    )
      throw new Error('dispatch-workspace-binding-changed');
    if (record.retired || record.retirement) throw new Error('dispatch-issue-inactive');
    if (record.reset) throw new Error('dispatch-reset-pending');
    if (record.handoff && !work && !feedback) throw new Error('dispatch-assessment-handed-off');
    const intake = current.admitted.records.find((entry) => entry.id === record.intakeId);
    if (!intake) throw new Error('dispatch-admission-missing');
    const held = liveWorkflowPolicy(
      fresh.manifest,
      'openclaw',
      intake,
      work || record.sessionCreation?.verified
        ? 'continued-work'
        : feedback
          ? 'feedback'
          : 'assignment',
    );
    if (held) throw new WorkflowPolicyHeld(held);
    return { current, intake, manifest: fresh.manifest };
  }

  /** Refresh provider authority at action entry and immediately before native dispatch. */
  private guardedCredential(
    revalidate: () => Promise<unknown>,
  ): Pick<SessionDispatchCredential, 'use'> {
    return {
      use: (authority, operation) =>
        this.dependencies.credential.use(authority, (request) =>
          operation(async (method, params) => {
            if (method === 'sessions.create' || method === 'chat.send') await revalidate();
            return request(method, params);
          }),
        ),
    };
  }

  async validate(
    manifest: AgentManifest,
    workspace: string,
    record: OpenClawDispatchRecord,
    work = false,
    feedback = false,
    connection?: GitHubNotificationIntakeClient & GitHubNotificationItemContextClient,
    signal?: AbortSignal,
  ) {
    const { current, intake } = await this.validateLocal(
      manifest,
      workspace,
      record,
      work,
      feedback,
    );
    const client =
      connection ??
      (await this.dependencies.connect(
        { manifest, workspaceDir: current.workspace },
        signal ?? AbortSignal.timeout(25000),
      ));
    const repo =
      (record.sessionCreation?.verified || record.effective?.status === 'verified') && !feedback
        ? (await inspectActiveIssue(intake, client)).repo
        : feedback
          ? await revalidateFeedbackAssignment(current.policy, intake, client, record)
          : (await inspectAdmittedIssue(intake, client)).repo;
    const worktreeInput = {
      agentId: manifest.agent.id,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      itemDatabaseId: intake.issue.databaseId,
      itemNumber: intake.issue.number,
      itemType: 'issue' as const,
      repositoryDatabaseId: repo.databaseId,
    };
    if (record.worktree) {
      const path = await realpath(record.worktree).catch((cause) => {
        throw new Error('dispatch-worktree-unavailable', { cause });
      });
      if (path !== record.worktree) throw new Error('dispatch-worktree-diverged');
    }
    return { client, repo, intake, worktreeInput };
  }

  async promptContext(
    manifest: AgentManifest,
    workspace: string,
    binding: Parameters<typeof openclawTurnContext>[1],
  ) {
    const current = await this.reportScope(manifest, workspace);
    const record = (await current.journal.read()).records.find(
      (entry) => entry.threadId === binding.sessionKey,
    );
    return record && openclawTurnContext(record, binding);
  }

  private async reportScope(manifest: AgentManifest, workspace: string) {
    const current = await this.dependencies.intake.select(manifest, workspace);
    const state = await current.store.read();
    if (!state) throw new Error('dispatch-intake-record-missing');
    return {
      ...current,
      selected: current.selected ?? retainedIntakePolicy(manifest, state, 'openclaw'),
      journal: new OpenClawDispatchStore(this.dependencies.root, current.store.location.scope),
    };
  }

  private async observe(manifest: AgentManifest, workspace: string): Promise<IntakeObservation> {
    try {
      const retained = await this.dependencies.intake.inspect(manifest, workspace);
      const code = retained.code ?? (await this.dependencies.intake.readiness(manifest, workspace));
      return { status: code ? 'blocked' : 'ready', changed: false, ...(code ? { code } : {}) };
    } catch (error) {
      return { status: 'blocked', changed: false, code: openClawDispatchFailureCode(error) };
    }
  }

  private async continueWork(
    manifest: AgentManifest,
    workspace: string,
    record: OpenClawDispatchRecord,
    save: () => Promise<void>,
    authority: DispatchAuthority,
    reconcileOnly = false,
  ) {
    if (
      openClawDecisionPending(
        record,
        manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
      )
    ) {
      const assertDecision = async () => {
        await authority.assertCurrent?.();
        authority.signal?.throwIfAborted();
        const live = await this.validateLocal(manifest, workspace, record);
        if (
          !record.decisionTurn &&
          !openClawDecisionPending(
            record,
            live.manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
          )
        )
          throw new WorkflowPolicyHeld('workflow-mode-updated');
      };
      try {
        await this.validate(manifest, workspace, record);
        return await this.guardedCredential(async () => {
          await this.validate(manifest, workspace, record);
          await assertDecision();
        }).use({ ...authority, assertCurrent: assertDecision }, (request) =>
          advanceOpenClawDecision({
            record,
            request,
            config: this.dependencies.config(),
            save,
            assertCurrent: assertDecision,
          }),
        );
      } catch (error) {
        return {
          status: 'assessment-pending',
          id: record.id,
          ...workflowFailure(error, openClawDispatchFailureCode(error)),
          nextAction: 'next',
        };
      }
    }
    const now = (this.dependencies.now ?? Date.now)();
    const assertCurrent = async () => {
      await authority.assertCurrent?.();
      authority.signal?.throwIfAborted();
      const live = await this.validateLocal(manifest, workspace, record, true);
      const transition = issueProgression(record, {
        mode: live.manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
        now,
      });
      if (transition.status !== 'ready') throw new WorkflowPolicyHeld(transition.reason);
    };
    try {
      await this.validate(manifest, workspace, record, true);
      const live = await this.validateLocal(manifest, workspace, record, true);
      return await this.guardedCredential(async () => {
        await this.validate(manifest, workspace, record, true);
        await assertCurrent();
      }).use({ ...authority, assertCurrent }, async (request) => {
        if (!record.request || !('key' in record.request))
          throw new Error('dispatch-work-context-mismatch');
        const selection =
          record.work?.selection ??
          (!record.work
            ? (
                await selectWorkflowStage({
                  stage: 'implementation',
                  configuration:
                    live.manifest.github?.notifications?.issueAssignment?.implementation,
                  workspace,
                  observedAt: now,
                  resolveSkill: (id) =>
                    openClawSkill(request, record.request as { key: string; agentId: string }, id),
                })
              ).selection
            : undefined);
        return advanceOpenClawWork({
          record,
          reconcileOnly,
          mode: live.manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
          selection,
          now,
          request,
          config: this.dependencies.config(),
          save,
          assertCurrent,
        });
      });
    } catch (error) {
      if (error instanceof WorkflowPolicyHeld)
        return { status: 'policy-held', id: record.id, reason: error.reason, nextAction: 'next' };
      const code = openClawDispatchFailureCode(error);
      if (
        record.work &&
        [
          'dispatch-turn-cancelled',
          'dispatch-turn-failed',
          'dispatch-turn-input-mismatch',
          'dispatch-turn-model-mismatch',
        ].includes(code)
      ) {
        record.work.code = code;
        await save();
      }
      return {
        status: 'implementation-pending',
        id: record.id,
        ...workflowFailure(error, code),
        nextAction: 'next',
      };
    }
  }

  private async feedback(
    manifest: AgentManifest,
    workspace: string,
    record: OpenClawDispatchRecord,
    event: OpenClawFeedbackEvent,
    caller: DispatchCaller,
    action: OpenClawFeedbackAction | undefined,
    save: () => Promise<void>,
    authority: DispatchAuthority,
  ) {
    const now = (this.dependencies.now ?? Date.now)();
    if (!action && event.retry && !dispatchRetryDue(event, now))
      return {
        status: 'retrying',
        id: record.id,
        eventId: event.id,
        code: event.code,
        nextAction: 'next',
      };
    try {
      const assertCurrent = async () => {
        authority.signal?.throwIfAborted();
        await authority.assertCurrent?.();
        await this.validateLocal(manifest, workspace, record, false, true);
      };
      await assertCurrent();
      const { intake, client } = await this.validate(
        manifest,
        workspace,
        record,
        false,
        true,
        undefined,
        authority.signal,
      );
      const provider = await this.dependencies.feedbackConnect?.(
        { manifest, workspaceDir: workspace },
        authority.signal ?? AbortSignal.timeout(60000),
        client,
      );
      if (!provider) throw new Error('feedback-provider-unavailable');
      return await this.guardedCredential(() =>
        this.validate(manifest, workspace, record, false, true, client, authority.signal),
      ).use({ ...authority, assertCurrent }, async (request) => {
        const common = {
          record,
          event,
          caller,
          request,
          config: this.dependencies.config(),
          provider,
          policy: (await this.scope(manifest, workspace)).policy.policy,
          intake,
          workspace,
          now,
          debug: manifest.debug,
          signal: authority.signal,
          connectDelivery: async () => {
            if (!this.dependencies.delivery) throw new Error('delivery-runtime-unavailable');
            return this.dependencies.delivery({
              manifest,
              workspaceDir: workspace,
              worktree: record.worktree!,
              caller,
              signal: authority.signal ?? AbortSignal.timeout(60000),
              connection: client,
            });
          },
          assertCurrent,
          livePolicy: async () => {
            const live = await this.validateLocal(manifest, workspace, record, false, true);
            return live.manifest.github!.notifications!;
          },
          reauthorize: async () => {
            await this.validate(manifest, workspace, record, false, true, client, authority.signal);
          },
          save,
        };
        if (!action || action.operation === 'reconcile') {
          await authorizeFeedback(common);
          delete event.policyHeld;
          const result = await advanceFeedbackTurn(common);
          if (event.turn?.status === 'completed') {
            record.feedback!.lastServedAt = now;
            if (record.feedback!.activity) record.feedback!.activity.busy = false;
            await save();
          }
          if (!event.publicationAttempted || event.receipt) return result;
          return openClawFeedback({
            ...common,
            action: {
              action: 'feedback',
              operation: 'reconcile',
              id: record.id,
              eventId: event.id,
            },
          });
        }
        return openClawFeedback({ ...common, action });
      });
    } catch (error) {
      if (error instanceof WorkflowPolicyHeld) {
        event.policyHeld = error.reason;
        await save();
        return {
          status: 'policy-held',
          id: record.id,
          eventId: event.id,
          reason: error.reason,
          nextAction: 'next',
        };
      }
      const code = openClawDispatchFailureCode(error);
      if (event.phase !== 'published') {
        event.code = code;
        if (code === 'feedback-composition-changed' && !event.publicationAttempted && event.result)
          delete event.result.publicText;
        scheduleDispatchRetry(event, code, error, now);
      }
      // unknown transport outcomes retain custody; terminal failures release the queued work.
      if (
        event.phase !== 'published' &&
        !event.retry &&
        /revoked|authority-changed|owner-changed|source-(?:changed|identity-changed|author-changed|no-longer-eligible)|resource-missing|denied|turn-(?:failed|cancelled)|publication-(?:text|secret|output|reconciliation)|session-mismatch/.test(
          code,
        )
      ) {
        event.phase = 'blocked';
        record.feedback!.lastServedAt = now;
      }
      if (event.phase !== 'published' && dispatchFailurePhase(event, code, error) === 'blocked')
        event.phase = 'blocked';
      await save();
      return {
        status: event.phase === 'blocked' ? 'blocked' : dispatchFailurePhase(event, code, error),
        id: record.id,
        eventId: event.id,
        nextAction: code === 'feedback-composition-changed' ? 'compose' : 'next',
        code,
        ...(code === 'feedback-composition-changed'
          ? {
              next: 'Call feedback compose with this id and eventId, then create a new candidate using the selected skill and guidance. No new stage approval is needed; do not repeat an attempted publication.',
            }
          : {}),
        ...(event.result
          ? {
              presentation: feedbackResponse({
                privateText: event.result.privateText,
                selection: event.composition,
                workspace,
                debug: manifest.debug,
                publication: { withheld: code },
              }),
            }
          : {}),
      };
    }
  }

  /** bounded private discovery; only saved actionable work or a progress notice wakes the model. */
  async check(
    manifest: AgentManifest,
    workspace: string,
    signal?: AbortSignal,
    observation?: IntakeObservation,
    selector?: GitHubNotificationItemSelector,
  ) {
    const budget = new DiscoveryBudget(20000, signal);
    const reporting = await this.reportScope(manifest, workspace);
    const intake =
      observation ??
      (await this.dependencies.intake.run(
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
            const source = admitted.find((item) => item.id === record.intakeId);
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
        service: this,
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
    });
    if (intake.status !== 'ready' && intake.code !== 'intake-search-incomplete')
      return {
        status: 'ready' as const,
        changed: report.changed,
        outcome: 'failed',
        code: intake.code,
      };
    const current = await this.scope(manifest, workspace);
    const sourceThreadId = await this.dependencies.coordinator(manifest, current.workspace);
    const cycleAt = state.discoveryCycleAt ?? (this.dependencies.now ?? Date.now)();
    const previousCodes = new Map(
      state.records.map((record) => [record.id, record.feedback?.code]),
    );
    const scans = await scanOpenClawFeedback({
      service: this,
      state,
      manifest,
      workspace: current.workspace,
      sourceThreadId,
      authority: { signal: budget.signal },
      budget,
      now: (this.dependencies.now ?? Date.now)(),
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
            ((!event.retry || dispatchRetryDue(event, (this.dependencies.now ?? Date.now)())) &&
              event.phase !== 'blocked' &&
              ((event.turn && (event.phase !== 'published' || event.turn.status !== 'completed')) ||
                (event.publicationAttempted && !event.receipt))) ||
            (event.phase === 'queued' &&
              !event.policyHeld &&
              (!event.retry || dispatchRetryDue(event, (this.dependencies.now ?? Date.now)())) &&
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
          (record.blocker && dispatchRetryDue(record, (this.dependencies.now ?? Date.now)()))),
    );
    const pending = pendingAssignments(state, current.admitted)
      .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
      .some(pendingAssignment);
    const workPending = state.records.some(
      (record) =>
        (openClawDecisionPending(
          record,
          manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
        ) ||
          openClawWorkSlot(
            record,
            manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
          )) &&
        (openClawItemOccupied(record) || capacity.available > 0),
    );
    const actionable =
      feedbackPending || recoverable || workPending || (capacity.available > 0 && pending);
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
        scans.some(
          (scan) => scan.feedback.code && scan.feedback.code !== previousCodes.get(scan.id),
        ) ||
        Boolean(
          state.discoveryProgress &&
          state.discoveryProgress.reported !== state.discoveryProgress.pending,
        ) ||
        actionable,
    };
  }

  private async report(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    authority: DispatchAuthority,
  ) {
    authority.signal?.throwIfAborted();
    const current = await this.reportScope(manifest, workspace);
    if (
      caller.sessionKey !== (await this.dependencies.coordinator(manifest, current.workspace, true))
    )
      throw new Error('dispatch-intake-caller-required');
    const observation = await this.observe(manifest, workspace);
    const intake = await current.store.read();
    return current.journal.exclusive(async (state, save) => {
      if (state.intakeReport?.runId === caller.runId)
        return {
          status: 'reported',
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
          record.intakeReportedAt = (this.dependencies.now ?? Date.now)();
      authority.signal?.throwIfAborted();
      await authority.assertCurrent?.();
      await save();
      return {
        status: 'reported',
        response,
        instructions:
          'Reproduce response unchanged. An empty response means no card. This receipt records report preparation, not verified visible delivery.',
      };
    });
  }

  async run(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    input: Static<typeof dispatchParameters>,
    operator = false,
    authority: DispatchAuthority = {},
  ) {
    if (input.action === 'check')
      return this.check(manifest, workspace, authority.signal, input.observation);
    if (input.action === 'report')
      return this.report(manifest, workspace, caller, authority).catch((error: unknown) => {
        if (openClawDispatchFailureCode(error) === privateStateFileLockBusyErrorCode)
          return { status: 'busy' as const, code: privateStateFileLockBusyErrorCode };
        throw error;
      });
    if (
      input.action === 'present' ||
      (input.action === 'delivery' && input.operation === 'present')
    ) {
      const selected = await this.dependencies.intake.select(manifest, workspace);
      const admitted = await selected.store.read();
      if (!admitted) throw new Error('dispatch-intake-record-missing');
      const journal = new OpenClawDispatchStore(
        this.dependencies.root,
        selected.store.location.scope,
      );
      return this.present(manifest, workspace, caller, input, authority, { admitted, journal });
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
      childAction && 'id' in input
        ? (await current.journal.read()).records.find((record) => record.id === input.id)
        : undefined;
    const sourceThreadId =
      retained?.sourceThreadId ??
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
    if (input.action === 'next')
      await reconcileOpenClawLifecycle({ service: this, manifest, workspace, authority });
    const snapshot = await current.journal.read();
    const scans =
      input.action === 'next' &&
      (!snapshot.discoveryCheckedAt || Date.now() - snapshot.discoveryCheckedAt > 120000)
        ? await scanOpenClawFeedback({
            service: this,
            state: snapshot,
            manifest,
            workspace: current.workspace,
            sourceThreadId,
            authority,
            now: (this.dependencies.now ?? Date.now)(),
            checkpoint: (scan) =>
              discoveryCheckpoint(current.journal, scan, authority.assertCurrent),
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
          dispatchCapacity(after.records, current.policy.policy.maxConcurrentItems).occupied >
            current.policy.policy.maxConcurrentItems
        )
          throw new Error('dispatch-at-capacity');
        const activeKeys = after.records
          .filter((record) => !record.retired && !record.retirement && !record.reset)
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
              status: 'discovery-progress',
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
        if (input.action === 'inspect')
          return {
            status: 'ready',
            records: state.records.map((record) => ({
              id: record.id,
              intakeId: record.intakeId,
              phase: record.phase,
              workflowStatus: workflowStatus(record),
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
              retirement: record.retirement,
              retired: record.retired,
              feedback: record.feedback,
            })),
          };
        const now = (this.dependencies.now ?? Date.now)();
        if (input.action === 'next') {
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
              await this.validate(manifest, workspace, record);
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
                const sessionId = await this.dependencies.credential.use(
                  { ...authority, signal },
                  (request) =>
                    verifyEmptyIssueSession(request, record, this.dependencies.config(), true),
                );
                record.sessionCreation.sessionId = sessionId;
                record.sessionCreation.verified = true;
                if ('key' in record.request) {
                  record.threadId = record.request.key;
                  record.effective = {
                    status: 'verified',
                    model: record.request.model,
                    effort: record.request.thinkingLevel,
                  };
                }
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
            await this.feedback(
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
                ].some((turn) => turn && turn.status !== 'completed'),
            )
            .slice(0, 12)) {
            const reconciled = await this.continueWork(
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
          const capacity = dispatchCapacity(
            state.records,
            current.policy.policy.maxConcurrentItems,
          );
          const assignments = pendingAssignments(state, current.admitted)
            .filter(({ intake }) => !liveWorkflowPolicy(manifest, 'openclaw', intake))
            .filter(pendingAssignment)
            .sort(
              (a, b) =>
                Date.parse(a.intake.assignment.createdAt) -
                  Date.parse(b.intake.assignment.createdAt) ||
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
                manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
              );
              const decision = openClawDecisionPending(
                record,
                manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
              );
              return slot || decision
                ? [
                    {
                      record,
                      slot,
                      candidateId: automationHash({ implementation: record.id }),
                      recovering: Boolean(
                        decision
                          ? record.decisionTurn
                          : slot && record.work?.[slot] && record.work[slot].status !== 'completed',
                      ),
                    },
                  ]
                : [];
            })
            .sort(
              (a, b) =>
                a.record.createdAt - b.record.createdAt ||
                a.candidateId.localeCompare(b.candidateId),
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
              return this.continueWork(manifest, current.workspace, continuing, save, {
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
                pass.candidates.includes(intake.id) &&
                (!record || !pass.selected.includes(record.id)),
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
                    (record.request && pass.candidates.includes(record.intakeId)) ||
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
            return { status: 'at-capacity' };
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
              pass.candidates.indexOf(workItem.candidateId) <
                pass.candidates.indexOf(feedback.event.id))
          ) {
            pass.selected.push(workItem.record.id);
            await save();
            return this.continueWork(manifest, current.workspace, workItem.record, save, {
              ...authority,
              signal,
            });
          }
          if (
            feedback &&
            (!pending ||
              pass.candidates.indexOf(feedback.event.id) <
                pass.candidates.indexOf(pending.intake.id))
          ) {
            pass.selected.push(feedback.record.id);
            await save();
            return this.feedback(
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
                enabled: workflowFeedbackEnabled(
                  manifest.github?.notifications,
                  'issue-assignment',
                ),
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
            const { client, repo, intake } = await this.validate(manifest, workspace, record);
            const evidence = await client.getItemContext(
              repo.owner.login,
              repo.name,
              intake.issue.number,
              'issue',
              true,
            );
            record.context = JSON.stringify(dispatchContext(evidence, source(intake), now));
            await save();
            return {
              status: 'routing-required',
              id: record.id,
              digest: digest(record),
              context: JSON.parse(record.context),
              assessmentSchema,
              routing: resolveModelRoutingRequest(
                manifest.models,
                current.manifestDigest,
                { action: 'inspect' },
                'openclaw',
              ),
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
              nextAction: 'next',
            };
          }
        }
        const record = state.records.find((entry) => entry.id === input.id);
        if (!record) throw new Error('dispatch-receipt-missing');
        if (input.action === 'feedback') {
          const event = record.feedback?.events.find((event) => event.id === input.eventId);
          if (!event) throw new Error('feedback-event-missing');
          if (input.operation === 'reconcile' && !event.turn)
            throw new Error('feedback-send-unverified');
          if (
            feedbackChild &&
            (caller.sessionKey !== record.threadId ||
              caller.sessionId !== record.sessionCreation?.sessionId ||
              caller.runId !== event.turn?.runId)
          )
            throw new Error('feedback-owner-caller-required');
          return this.feedback(manifest, current.workspace, record, event, caller, input, save, {
            ...authority,
            signal: authority.signal
              ? AbortSignal.any([authority.signal, transactionSignal])
              : transactionSignal,
          });
        }
        const feedbackSource = record.feedback?.events.find(
          (event) => event.turn?.runId === caller.runId,
        );
        if (feedbackSource) {
          return this.feedback(
            manifest,
            current.workspace,
            record,
            feedbackSource,
            caller,
            input.action === 'implementation-context' || input.action === 'implementation-result'
              ? {
                  ...input,
                  action: 'feedback',
                  operation: input.action,
                  eventId: feedbackSource.id,
                }
              : input.action === 'delivery'
                ? {
                    ...input,
                    action: 'feedback',
                    operation: 'delivery',
                    deliveryOperation: input.operation,
                    eventId: feedbackSource.id,
                  }
                : {
                    action: 'feedback',
                    id: record.id,
                    eventId: feedbackSource.id,
                    operation: 'context',
                  },
            save,
            authority,
          );
        }
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
            status: 'routing-required',
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
        const { client, intake, worktreeInput, repo } = await this.validate(
          manifest,
          workspace,
          record,
          workAction,
          false,
          undefined,
          authority.signal
            ? AbortSignal.any([authority.signal, transactionSignal])
            : transactionSignal,
        );
        if (
          input.action === 'handoff' ||
          input.action === 'implementation-context' ||
          input.action === 'implementation-result' ||
          input.action === 'delivery'
        ) {
          const signal = authority.signal
            ? AbortSignal.any([authority.signal, transactionSignal])
            : transactionSignal;
          const assertCurrent = async () => {
            signal.throwIfAborted();
            await authority.assertCurrent?.();
            await this.validateLocal(manifest, workspace, record, true);
            signal.throwIfAborted();
          };
          return this.dependencies.credential.use({ signal, assertCurrent }, async (request) => {
            const { source, message, progression } = await verifyOpenClawWork({
              record,
              caller,
              operator,
              mode:
                (await this.validateLocal(manifest, workspace, record, true)).manifest.github
                  ?.notifications?.issueAssignment?.mode ?? 'auto',
              now,
              request,
              config: this.dependencies.config(),
            });
            await assertCurrent();
            if (
              input.action === 'implementation-context' &&
              record.work?.result?.outcome !== 'done'
            ) {
              if (!record.request || !('key' in record.request))
                throw new Error('dispatch-work-context-mismatch');
              const previous = record.work?.selection;
              const configured = (await this.validateLocal(manifest, workspace, record, true))
                .manifest.github?.notifications?.issueAssignment?.implementation;
              const selected = (
                await selectWorkflowStage({
                  stage: 'implementation',
                  configuration: configured,
                  workspace: current.workspace,
                  observedAt: previous?.observedAt ?? now,
                  resolveSkill: (id) =>
                    openClawSkill(request, record.request as { key: string; agentId: string }, id),
                })
              ).selection;
              // retain selection with the context that first enters implementation.
              const response = await openClawWorkAction({
                record,
                caller,
                source,
                progression,
                action: input,
                message,
                now,
                assertCurrent,
                save,
              });
              if (record.work) {
                record.work.selection ??= selected;
                await save();
              }
              return {
                ...response,
                implementation: selected,
              };
            }
            if (input.action !== 'delivery')
              return openClawWorkAction({
                record,
                caller,
                source,
                progression,
                action: input,
                now,
                assertCurrent,
                save,
              });
            return openClawDelivery({
              record,
              intake,
              action: input,
              source,
              base: repo.defaultBranch,
              recipients: current.policy.policy.issueAssignment?.pullRequest?.recipients,
              feedbackEnabled: openClawFeedbackEnabled(manifest),
              selectAnnouncement: async (retained) =>
                (
                  await selectFeedbackStage({
                    policy: current.policy.policy,
                    workflow: 'issue-assignment',
                    workspace: current.workspace,
                    observedAt: retained?.composition.observedAt ?? now,
                    resolveSkill: (id) => {
                      if (!record.request || !('key' in record.request))
                        throw new Error('delivery-announcement-owner-required');
                      return openClawSkill(request, record.request, id);
                    },
                  })
                ).selection,
              signal,
              assertCurrent,
              reauthorize: async () => {
                await this.validate(manifest, workspace, record, true, false, client, signal);
              },
              save,
              connect: async () => {
                if (!this.dependencies.delivery) throw new Error('delivery-runtime-unavailable');
                return this.dependencies.delivery({
                  manifest,
                  workspaceDir: current.workspace,
                  worktree: record.worktree!,
                  caller,
                  signal,
                  connection: client,
                });
              },
            }).catch((error: unknown) => {
              signal.throwIfAborted();
              const code = openClawDispatchFailureCode(error);
              return {
                status: dispatchFailurePhase({}, code, error),
                workflowStatus: record.work?.delivery?.pullRequest
                  ? 'partially-delivered'
                  : dispatchFailurePhase({}, code, error),
                id: record.id,
                ...workflowFailure(error, code),
                code: code === 'dispatch-operation-failed' ? 'delivery-provider-failed' : code,
                pullRequest: record.work?.delivery?.pullRequest,
                instructions:
                  'Preserve this operation and all work. Stop on denial or lost authority. For an interrupted publication, use delivery prepare again in this issue chat to reconcile the existing attempt. Never create a replacement PR or discard its retained binding.',
              };
            });
          });
        }
        if (input.action === 'context' || input.action === 'result' || input.action === 'summary') {
          const signal = authority.signal
            ? AbortSignal.any([authority.signal, transactionSignal])
            : transactionSignal;
          const childAuthority = {
            signal,
            assertCurrent: async () => {
              signal.throwIfAborted();
              await authority.assertCurrent?.();
              await this.validateLocal(manifest, workspace, record);
              signal.throwIfAborted();
            },
          };
          await childAuthority.assertCurrent();
          return this.dependencies.credential.use(childAuthority, async (request) => {
            if (input.action === 'summary') {
              if (
                !record.result ||
                !record.request ||
                !('key' in record.request) ||
                record.assessmentCaller?.runId !== caller.runId
              )
                throw new Error('assessment-summary-assessment-turn-required');
              const expected = record.request;
              return assessmentSummary({
                record,
                intake,
                action: input,
                turnId: caller.runId,
                authorityDigest: automationHash({
                  sourceThreadId,
                  manifest: current.manifestDigest,
                }),
                presentation: assessmentPresentation(
                  record.result,
                  record,
                  intake,
                  current.workspace,
                  { debug: manifest.debug },
                ),
                save,
                redact: redactFeedback,
                authorize: async () => {
                  await childAuthority.assertCurrent();
                  await this.validate(manifest, workspace, record, false, false, undefined, signal);
                },
                select: async (previous) =>
                  (
                    await selectFeedbackStage({
                      policy: current.policy.policy,
                      workflow: 'issue-assignment',
                      workspace: current.workspace,
                      observedAt: previous?.observedAt ?? now,
                      resolveSkill: (id) => openClawSkill(request, expected, id),
                    })
                  ).selection,
                connect: async () => {
                  const provider = await this.dependencies.feedbackConnect?.(
                    { manifest, workspaceDir: current.workspace },
                    signal,
                    client,
                  );
                  if (!provider) throw new Error('assessment-summary-provider-unavailable');
                  return { client: provider };
                },
              });
            }
            const selection =
              input.action === 'context' || !record.assessment
                ? await selectOpenClawAssessment({
                    request,
                    record,
                    workspace: current.workspace,
                    configuration: current.policy.policy.issueAssignment?.assessment,
                    now,
                  })
                : undefined;
            const evidence =
              input.action === 'context'
                ? JSON.stringify(
                    dispatchContext(
                      await client.getItemContext(
                        repo.owner.login,
                        repo.name,
                        intake.issue.number,
                        'issue',
                        true,
                      ),
                      source(intake),
                      now,
                    ),
                  )
                : undefined;
            await childAuthority.assertCurrent();
            return issueAssessmentAction({
              selection,
              evidence,
              request,
              record,
              caller,
              intake,
              workspace: current.workspace,
              policy: manifest.github?.notifications,
              config: this.dependencies.config(),
              debug: manifest.debug,
              ...input,
              save,
              assertCurrent: childAuthority.assertCurrent,
            });
          });
        }
        if (input.action === 'prepare') {
          const pass = state.openclawPasses?.find((entry) => sameIntakeRun(entry, caller));
          if (!pass?.selected.includes(record.id))
            throw new Error('dispatch-pass-selection-required');
          if (record.request) return { status: 'reconcile-required', id: record.id };
          if (!dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems).available)
            return { status: 'at-capacity', id: record.id };
          if (record.phase !== 'routing' || input.digest !== digest(record) || !record.context)
            throw new Error('dispatch-preparation-stale');
          preparationStage = 'routing';
          const metadata = JSON.parse(record.context).metadata?.complexity;
          const routing = resolveModelRoutingRequest(
            manifest.models,
            current.manifestDigest,
            {
              action: 'resolve',
              manifestDigest: current.manifestDigest,
              context: record.context.slice(0, 17950) + '\n[Bounded routing snapshot.]',
              assessment: input.assessment,
              ...(metadata?.status === 'verified'
                ? { evidence: { complexity: metadata.value, source: metadata.source } }
                : {}),
              ...(input.fallback ? { fallback: input.fallback } : {}),
            },
            'openclaw',
          );
          if (!('candidate' in routing) || routing.candidate?.status !== 'mapped')
            throw new Error('dispatch-routing-unresolved');
          preparationStage = 'worktree';
          const worktree = await this.dependencies.worktrees.prepareGitHub({
            ...worktreeInput,
            title: input.title,
          });
          record.worktree = worktree.path;
          record.routing = JSON.stringify(routing);
          record.routingNote = `Requested ${routing.candidate.model} / ${routing.candidate.thinking}; session settings are verified at creation, not model execution.`;
          delete record.retry;
          delete record.retryAfter;
          record.request = {
            key: `agent:${manifest.agent.id}:dashboard:agent-system-issue-${record.id}`,
            idempotencyKey: record.id,
            agentId: manifest.agent.id,
            label: `#${intake.issue.number}: ${input.title.trim().toUpperCase()}`,
            category: intake.repository.name,
            cwd: worktree.path,
            model: routing.candidate.model,
            thinkingLevel: routing.candidate.thinking,
          };
          record.sessionCreation = {
            attempted: false,
            sourceSessionId: caller.sessionId,
            sourceRunId: caller.runId,
            sourceToolCallId: caller.toolCallId,
          };
          record.phase = 'creating';
          preparationStage = 'verification';
          await this.validateLocal(manifest, workspace, record);
          await save();
        }
        if (
          input.action === 'prepare' ||
          input.action === 'reconcile' ||
          input.action === 'start' ||
          input.action === 'assess'
        ) {
          if (!record.sessionCreation || !record.request || !('key' in record.request))
            throw new Error('dispatch-legacy-handoff-retained');
          if (
            record.request.agentId !== manifest.agent.id ||
            record.request.key !==
              `agent:${manifest.agent.id}:dashboard:agent-system-issue-${record.id}` ||
            record.request.idempotencyKey !== record.id ||
            record.request.category !== intake.repository.name
          )
            throw new Error('dispatch-session-binding-changed');
          const assessment = input.action === 'assess' || Boolean(record.assessmentTurn);
          const working = assessment || input.action === 'start' || Boolean(record.firstTurn);
          preparationStage = assessment
            ? 'assessment-turn'
            : working
              ? 'first-turn'
              : 'session-create';
          const signal = authority.signal
            ? AbortSignal.any([authority.signal, transactionSignal])
            : transactionSignal;
          const turnAuthority = {
            signal,
            assertCurrent: async () => {
              signal.throwIfAborted();
              await authority.assertCurrent?.();
              if (
                (await this.dependencies.coordinator(manifest, current.workspace)) !==
                sourceThreadId
              )
                throw new Error('dispatch-coordinator-binding-changed');
              await this.validateLocal(manifest, workspace, record);
              signal.throwIfAborted();
            },
          };
          if (assessment && !record.assessmentTurn) {
            await turnAuthority.assertCurrent();
            await this.dependencies.credential.use(turnAuthority, async (request) => {
              await selectOpenClawAssessment({
                request,
                record,
                workspace: current.workspace,
                configuration: current.policy.policy.issueAssignment?.assessment,
                now,
              });
              await turnAuthority.assertCurrent();
              await save();
            });
          }
          return (working ? advanceIssueTurn : createIssueSession)({
            config: this.dependencies.config(),
            credential: this.guardedCredential(() =>
              this.validate(manifest, workspace, record, false, false, client, signal),
            ),
            record,
            save,
            authority: turnAuthority,
            assessment,
            presentation: { intake, workspace: current.workspace, debug: manifest.debug },
          });
        }
        throw new Error('dispatch-action-invalid');
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
            code: privateStateFileLockBusyErrorCode,
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

  private async present(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    action: Extract<Static<typeof dispatchParameters>, { action: 'delivery' | 'present' }>,
    authority: DispatchAuthority,
    current: Pick<Awaited<ReturnType<OpenClawDispatch['scope']>>, 'admitted' | 'journal'>,
  ) {
    let stage: 'snapshot' | 'verification' | 'commit' = 'snapshot';
    let enteredJournal = false;
    const signal = authority.signal ?? new AbortController().signal;
    try {
      signal.throwIfAborted();
      const record = await current.journal.exclusive(async (state) => {
        enteredJournal = true;
        signal.throwIfAborted();
        const retained = state.records.find((entry) => entry.id === action.id);
        if (!retained) throw new Error('dispatch-receipt-missing');
        if (
          caller.sessionKey !== retained.threadId ||
          caller.sessionId !== retained.sessionCreation?.sessionId ||
          !retained.assessmentTurn
        )
          throw new Error('dispatch-assessment-caller-mismatch');
        return structuredClone(retained);
      });
      const snapshot = automationHash(record);
      stage = 'verification';
      const assertCurrent = async () => {
        signal.throwIfAborted();
        await authority.assertCurrent?.();
      };
      await assertCurrent();
      const intake = current.admitted.records.find((entry) => entry.id === record.intakeId);
      if (!intake) throw new Error('dispatch-intake-record-missing');
      await this.dependencies.credential.use({ signal, assertCurrent }, async (request) => {
        await describeIssueSession(request, record, this.dependencies.config(), true);
      });
      await assertCurrent();
      const result =
        action.action === 'present'
          ? (() => {
              if (!record.result) throw new Error('dispatch-result-missing');
              return {
                status: 'presented',
                retained: true,
                id: record.id,
                presentation: assessmentPresentation(record.result, record, intake, workspace, {
                  debug: manifest.debug,
                }),
                instructions:
                  'Show this complete saved assessment. This read does not authorize assessment, implementation, or publication.',
              };
            })()
          : presentOpenClawDelivery(record, intake, openClawFeedbackEnabled(manifest));
      if (action.action === 'present') return result;
      stage = 'commit';
      enteredJournal = false;
      return await current.journal.exclusive(async (state, save, lockSignal) => {
        enteredJournal = true;
        signal.throwIfAborted();
        lockSignal.throwIfAborted();
        await authority.assertCurrent?.();
        const retained = state.records.find((entry) => entry.id === action.id);
        if (!retained || automationHash(retained) !== snapshot)
          throw new Error('delivery-presentation-state-changed');
        retained.work!.delivery!.presentation = record.work!.delivery!.presentation;
        signal.throwIfAborted();
        await save();
        return result;
      });
    } catch (error) {
      signal.throwIfAborted();
      const code = openClawDispatchFailureCode(error);
      if (stage !== 'verification' && !enteredJournal && code === privateStateFileLockBusyErrorCode)
        return {
          status: 'busy' as const,
          id: action.id,
          code,
          operation: 'present' as const,
          retryable: true,
          stage,
          instructions:
            action.action === 'present'
              ? 'Retry present in this issue chat to show the saved assessment. This read grants no workflow authority.'
              : 'Retry delivery present in this issue chat to show the existing PR. Publication state is unchanged. Do not publish or create a replacement PR.',
        };
      return {
        status: 'blocked' as const,
        id: action.id,
        code: code === 'dispatch-operation-failed' ? 'delivery-provider-failed' : code,
        instructions:
          action.action === 'present'
            ? 'Preserve the saved assessment. Retry present in its owning issue chat after resolving this read failure.'
            : 'Preserve the existing PR and receipt. After an interrupted presentation, retry delivery present in this issue chat; never create a replacement PR.',
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
