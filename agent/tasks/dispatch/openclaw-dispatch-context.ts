import {
  selectOpenClawTaskContext,
  type OpenClawTaskContextDependencies,
  type OpenClawTaskContext,
} from '../context/openclaw-task-context.ts';
import { withDispatchTask } from './dispatch-task-scope.ts';
import { realpath } from 'node:fs/promises';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import AgentSystemToolError from '../../../api/error.ts';
import GitHubIdentityCache from '../../../channels/github/identity-cache.ts';
import { IntakeError } from '../../../channels/github/intake/record-store.ts';
import { GitHubWorkEventClientError } from '../../../channels/github/provider/work-event-api-client.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../../../channels/github/provider/work-event-types.ts';
import { GitHubNotificationCommentPublisherError } from '../../../channels/github/publication/comment-publisher.ts';
import {
  GitHubIssueDeliveryError,
  type default as IssueDeliveryProvider,
} from '../../../channels/github/publication/issue-delivery.ts';
import { GitHubNotificationPublicationError } from '../../../channels/github/publication/publication-contract.ts';
import { GitHubAccountClientError } from '../../../core/github-account-client.ts';
import { stateSnapshotConflictCode } from '../../../core/merge-state-snapshot.ts';
import {
  privateStateFileLockBusyErrorCode,
  privateStateFileLockLostErrorCode,
} from '../../../core/private-state-file-lock.ts';
import {
  type DispatchAuthority,
  type default as SessionDispatchCredential,
} from '../../../credentials/session-dispatch.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import GitCommandError from '../../../tools/git/command-error.ts';
import type TrustedGitWorktreeService from '../../../tools/git/trusted-worktree-service.ts';
import GitWorktreeConflict from '../../../tools/git/worktree-conflict.ts';
import AssessmentValidationError from '../assessment/assessment-validation.ts';
import type AssignmentClaimStore from './assignment-claim-store.ts';
import { inspectFeedbackAssignment } from '../feedback/assignment-feedback-reactivation.ts';
import { automationHash } from '../../automation-hash.ts';
import {
  inspectAdmittedIssue,
  inspectContinuedIssue,
  inspectIssueIdentity,
} from './dispatch-assignment.ts';
import { feedbackConversationMode } from '../feedback/feedback-conversation-mode.ts';
import { feedbackInputContext } from '../feedback/feedback-input.ts';
import authorizeFeedback from '../feedback/feedback-source-context.ts';
import { ContextMaterialError } from '../implementation/implementation-material.ts';
import { retainedIssueProgression } from '../issue-progression.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from '../live-workflow-policy.ts';
import {
  dispatchAdmission,
  managedIssueState,
  managedPullRequest,
  managedTargetUrl,
} from '../managed-issue.ts';
import { assertNotificationManagement } from '../../notification-reset-state.ts';
import type OpenClawAssignmentClaims from './openclaw-assignment-claims.ts';
import { type OpenClawDeliveryConnection } from '../delivery/openclaw-delivery.ts';
import OpenClawDispatchStore, {
  type OpenClawDispatchRecord,
  type OpenClawDispatchState,
} from './openclaw-dispatch-state.ts';
import {
  resolveOpenClawTurnFeedback,
  selectedOpenClawFeedback,
} from '../feedback/openclaw-feedback-input.ts';
import { type FeedbackProvider } from '../feedback/feedback-provider.ts';
import { type IntakeObservation } from '../../openclaw-intake-report.ts';
import type OpenClawIntake from '../../openclaw-intake.ts';
import { nativeTurnFor } from '../../openclaw-native-turns.ts';
import { type DispatchCaller } from '../../openclaw-session-create.ts';
import { openClawSkillResolver } from '../../openclaw-skill.ts';
import openclawTurnContext from '../context/openclaw-turn-context.ts';
import retainedIntakePolicy from '../retained-intake-policy.ts';
import taskTurnContext from '../context/task-turn-context.ts';
import WorkflowRequestError from '../workflow-request-error.ts';
export interface OpenClawTaskDependencies {
  root: string;
  claimStore?: AssignmentClaimStore;
  claims?: OpenClawAssignmentClaims;
  config(): OpenClawConfig;
  taskContext: OpenClawTaskContextDependencies;
  connect(
    input: {
      manifest: AgentManifest;
      workspaceDir: string;
    },
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
  assessmentGit?(input: {
    manifest: AgentManifest;
    workspace: string;
    caller: DispatchCaller;
    cwd: string;
    argv: string[];
    signal: AbortSignal;
  }): Promise<string>;
  now?: () => number;
  feedbackConnect?(
    input: {
      manifest: AgentManifest;
      workspaceDir: string;
    },
    signal: AbortSignal,
    connection?: GitHubNotificationIntakeClient & GitHubNotificationItemContextClient,
  ): Promise<FeedbackProvider>;
  retirementDelivery?(
    input: {
      manifest: AgentManifest;
      workspaceDir: string;
    },
    signal: AbortSignal,
    connection: GitHubNotificationIntakeClient,
  ): Promise<IssueDeliveryProvider>;
  delivery?(input: {
    manifest: AgentManifest;
    workspaceDir: string;
    worktree: string;
    caller: DispatchCaller;
    signal: AbortSignal;
    connection?: GitHubNotificationIntakeClient & GitHubNotificationItemContextClient;
  }): Promise<OpenClawDeliveryConnection>;
}
export interface OpenClawDispatchDependencies extends OpenClawTaskDependencies {
  intake: Pick<OpenClawIntake, 'run' | 'check' | 'inspect' | 'readiness'>;
}
export function openClawDispatchFailureCode(error: unknown): string {
  if (error instanceof ContextMaterialError) return error.code;
  if (error instanceof AssessmentValidationError || error instanceof WorkflowRequestError)
    return error.code;
  const conflict = error instanceof AgentSystemToolError ? error.cause : error;
  if (conflict instanceof GitWorktreeConflict) return conflict.code;
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
export default class OpenClawDispatchContext {
  constructor(readonly dependencies: OpenClawDispatchDependencies) {}
  async scope(manifest: AgentManifest, workspace: string, selection?: OpenClawTaskContext) {
    const current =
      selection ??
      (await selectOpenClawTaskContext(this.dependencies.taskContext, manifest, workspace));
    await assertNotificationManagement(this.dependencies.root, current.store.location.scope);
    const journal = new OpenClawDispatchStore(this.dependencies.root, current.store.location.scope);
    const admitted = managedIssueState(await current.store.read(), (await journal.read()).records);
    if (!admitted) throw new Error('dispatch-intake-activation-required');
    const selected = current.selected ?? retainedIntakePolicy(manifest, admitted, 'openclaw');
    return {
      ...current,
      admitted,
      policy: selected,
      manifestDigest: automationHash({ policy: selected.digest, models: manifest.models }),
      journal,
    };
  }
  /** Local custody checks stay cheap enough to run before every native operation. */
  async validateLocal(
    manifest: AgentManifest,
    workspace: string,
    record: OpenClawDispatchRecord,
    work = false,
    feedback: boolean | 'native' = false,
  ) {
    const current = await this.scope(manifest, workspace);
    const fresh = await this.dependencies.taskContext.manifestService.loadForAgentId(
      manifest.agent.id,
      'service',
    );
    if (fresh.status !== 'loaded') throw new Error('dispatch-manifest-unavailable');
    if (
      fresh.scope.workspaceDir !== current.workspace ||
      fresh.manifest.agent.id !== manifest.agent.id
    )
      throw new Error('dispatch-workspace-binding-changed');
    if (
      record.supersededBy ||
      (await current.journal.read()).records.find((r) => r.id === record.id)?.supersededBy
    )
      throw new Error('dispatch-task-superseded');
    if (
      feedback !== 'native' &&
      record.retirement &&
      record.retirement.reason !== 'assignment-removed'
    )
      throw new Error('dispatch-issue-inactive');
    if (record.reset) throw new Error('dispatch-reset-pending');
    const intake = dispatchAdmission(record, current.admitted.records ?? []);
    if (!intake) throw new Error('dispatch-admission-missing');
    if (!('initiation' in intake) && !record.sessionCreation?.attempted) {
      const consumed = current.admitted.observedAssignments?.find(
        (entry) => entry.id === intake.id,
      )?.consumedBy;
      if (consumed && consumed !== record.id) throw new Error('dispatch-assignment-consumed');
    }
    if (
      'initiation' in intake &&
      (intake.agentId !== manifest.agent.id ||
        intake.workspaceDir !== current.workspace ||
        intake.scope !== current.store.location.scope)
    )
      throw new Error('dispatch-workspace-binding-changed');
    await new GitHubIdentityCache(current.store.location).hydrate(
      fresh.manifest.github?.notifications,
    );
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
  guardedCredential(
    revalidate: (method: 'sessions.create' | 'chat.send') => Promise<unknown>,
  ): Pick<SessionDispatchCredential, 'use'> {
    return {
      use: (authority, operation) =>
        this.dependencies.credential.use(authority, (request) =>
          operation(async (method, params) => {
            if (method === 'sessions.create' || method === 'chat.send') await revalidate(method);
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
    feedback: boolean | 'native' = false,
    connection?: GitHubNotificationIntakeClient & GitHubNotificationItemContextClient,
    signal?: AbortSignal,
    inspectCheckout = true,
  ) {
    const {
      current,
      intake,
      manifest: liveManifest,
    } = await this.validateLocal(manifest, workspace, record, work, feedback);
    const client =
      connection ??
      (await this.dependencies.connect(
        { manifest, workspaceDir: current.workspace },
        signal ?? AbortSignal.timeout(25000),
      ));
    const identities = new GitHubIdentityCache(current.store.location);
    await identities.resolve(
      liveManifest.github?.notifications,
      client,
      feedback ? 'feedback' : 'assignment',
    );
    await identities.hydrate(manifest.github?.notifications);
    const { repo, item } =
      (record.sessionCreation?.verified || record.effective?.status === 'verified') && !feedback
        ? await inspectContinuedIssue(
            intake,
            client,
            liveManifest.github?.notifications?.issueAssignment?.allowed ?? [],
            record,
            (this.dependencies.now ?? Date.now)(),
          )
        : feedback === 'native'
          ? await inspectIssueIdentity(intake, client)
          : feedback
            ? await inspectFeedbackAssignment(
                {
                  ...current.policy,
                  policy: {
                    ...current.policy.policy,
                    issueAssignment: {
                      ...current.policy.policy.issueAssignment!,
                      allowed: liveManifest.github?.notifications?.issueAssignment?.allowed ?? [],
                    },
                  },
                },
                intake,
                client,
                record,
              )
            : await inspectAdmittedIssue(
                intake,
                client,
                Boolean(record.sessionCreation?.attempted),
              );
    const pullRequest = managedPullRequest(intake);
    if (
      pullRequest &&
      !record.sessionCreation?.attempted &&
      item.pullRequest?.headSha !== pullRequest.headSha
    )
      throw new Error('launch-pull-request-head-changed');
    const worktreeInput = {
      agentId: manifest.agent.id,
      attemptId: record.worktreeAttemptId,
      separateCheckout: Boolean(
        record.separateCheckout || record.manualIssue?.fresh || record.predecessorId,
      ),
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      itemDatabaseId: intake.issue.databaseId,
      itemNumber: intake.issue.number,
      itemType: pullRequest ? ('pull-request' as const) : ('issue' as const),
      ...(pullRequest
        ? { startingHead: { headRef: pullRequest.headRef, headSha: pullRequest.headSha } }
        : {}),
      repositoryDatabaseId: repo.databaseId,
    };
    if (record.worktree && !feedback && inspectCheckout) {
      const path = await realpath(record.worktree).catch((cause) => {
        throw new Error('dispatch-worktree-unavailable', { cause });
      });
      if (path !== record.worktree) throw new Error('dispatch-worktree-diverged');
    }
    return { client, repo, item, intake, worktreeInput };
  }
  async promptContext(
    manifest: AgentManifest,
    workspace: string,
    binding: Parameters<typeof openclawTurnContext>[1],
  ) {
    const retained = await this.readTurnContext(manifest, workspace, binding);
    return (
      retained &&
      openclawTurnContext(
        retained.record,
        { ...binding, workspace, repository: retained.repository },
        retained.context,
      )
    );
  }
  readTurnContext(...args: Parameters<OpenClawDispatchContext['readTaskContext']>) {
    return withDispatchTask('openclaw', args[2].sessionKey, () => this.readTaskContext(...args));
  }
  private async readTaskContext(
    manifest: AgentManifest,
    workspace: string,
    binding: Parameters<typeof openclawTurnContext>[1],
    authority: DispatchAuthority = {},
  ) {
    const current = await selectOpenClawTaskContext(
      this.dependencies.taskContext,
      manifest,
      workspace,
      {
        resolvePolicy: false,
      },
    );
    const journal = new OpenClawDispatchStore(this.dependencies.root, current.store.location.scope);
    const records = (await journal.read()).records.filter(
      (entry) => entry.threadId === binding.sessionKey,
    );
    if (records.length > 1) throw new Error('native-context-owner-ambiguous');
    const record = records[0];
    const admission =
      record && dispatchAdmission(record, (await current.store.read())?.records ?? []);
    if (!record || !openclawTurnContext(record, binding)) return;
    if (!admission) throw new Error('turn-context-admission-unavailable');
    const assertCurrent = async () => {
      authority.signal?.throwIfAborted();
      await authority.assertCurrent?.();
      const next = (await journal.read()).records.find((entry) => entry.id === record.id);
      if (!next || !openclawTurnContext(next, binding))
        throw new Error('turn-context-native-caller-changed');
    };
    const nativeAuthority = { ...authority, assertCurrent };
    let feedback;
    let feedbackLimitation;
    let feedbackTurn = Boolean(selectedOpenClawFeedback(record, binding.runId!));
    const caller = {
      sessionKey: binding.sessionKey!,
      sessionId: binding.sessionId!,
      runId: binding.runId!,
    };
    try {
      const selected = record.feedback?.events.length
        ? await this.dependencies.credential.use(nativeAuthority, (request) =>
            resolveOpenClawTurnFeedback(
              record,
              caller,
              request,
              this.dependencies.config(),
              binding.inputId,
            ),
          )
        : undefined;
      const event = selected?.event;
      feedbackTurn ||= Boolean(event);
      if (event) {
        const provider = await this.dependencies.feedbackConnect?.(
          { manifest, workspaceDir: workspace },
          authority.signal ?? new AbortController().signal,
        );
        if (!provider) throw new Error('feedback-provider-unavailable');
        await authorizeFeedback({
          conversation: true,
          record,
          event,
          intake: admission,
          policy: manifest.github!.notifications!,
          provider,
          assertCurrent,
        });
        feedback = feedbackInputContext({
          event,
          repository: `${admission.repository.owner.login}/${admission.repository.name}`,
          mode: feedbackConversationMode(record, manifest.github!.notifications!),
          issueStage: retainedIssueProgression(record)?.stage ?? 'planning',
          self: JSON.parse(event.source).author?.nodeId === provider.identity.nodeId,
        });
      }
    } catch (error) {
      feedbackLimitation = { code: openClawDispatchFailureCode(error) };
    }
    const initial = nativeTurnFor(record, 'assessment')?.runId === binding.runId;
    const stage = feedbackTurn
      ? 'feedback'
      : retainedIssueProgression(record)
        ? 'implementation'
        : record.feedback?.events.length && !initial
          ? 'conversation'
          : 'assessment';
    const context = await taskTurnContext({
      runtime: 'openclaw',
      manifest,
      workspace,
      record,
      target: managedTargetUrl(admission),
      stage,
      feedback,
      feedbackLimitation,
      resolveSkill: openClawSkillResolver(
        (method, params) =>
          this.dependencies.credential.use(nativeAuthority, (request) => request(method, params)),
        { agentId: binding.agentId!, key: binding.sessionKey! },
      ),
      now: this.dependencies.now?.(),
    });
    await assertCurrent();
    return {
      record,
      context,
      repository: `${admission.repository.owner.login}/${admission.repository.name}`,
    };
  }
  async reportScope(manifest: AgentManifest, workspace: string) {
    const current = await selectOpenClawTaskContext(
      this.dependencies.taskContext,
      manifest,
      workspace,
    );
    const journal = new OpenClawDispatchStore(this.dependencies.root, current.store.location.scope);
    const dispatchState = await journal.read();
    const state = managedIssueState(await current.store.read(), dispatchState.records);
    if (!state) throw new Error('dispatch-intake-record-missing');
    return {
      ...current,
      context: current,
      dispatchState,
      selected: current.selected ?? retainedIntakePolicy(manifest, state, 'openclaw'),
      journal,
    };
  }
  async observe(manifest: AgentManifest, workspace: string): Promise<IntakeObservation> {
    try {
      const retained = await this.dependencies.intake.inspect(manifest, workspace);
      const code = retained.code ?? (await this.dependencies.intake.readiness(manifest, workspace));
      return { status: code ? 'blocked' : 'ready', changed: false, ...(code ? { code } : {}) };
    } catch (error) {
      return { status: 'blocked', changed: false, code: openClawDispatchFailureCode(error) };
    }
  }
}
export type OpenClawDispatchScope = Awaited<ReturnType<OpenClawDispatchContext['scope']>>;
export interface OpenClawDispatchTransaction {
  manifest: AgentManifest;
  workspace: string;
  caller: DispatchCaller;
  authority: DispatchAuthority;
  current: OpenClawDispatchScope;
  state: OpenClawDispatchState;
  save: () => Promise<void>;
  transactionSignal: AbortSignal;
  sourceThreadId: string;
  now: number;
}
export type OpenClawDispatchValidation = Awaited<ReturnType<OpenClawDispatchContext['validate']>>;
