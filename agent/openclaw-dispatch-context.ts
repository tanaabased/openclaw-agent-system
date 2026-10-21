import { assertNotificationManagement } from './notification-reset-state.ts';
import { realpath } from 'node:fs/promises';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import type readInstallationConfig from '../core/installation-config.ts';
import AgentSystemToolError from '../api/error.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';
import { GitHubNotificationCommentPublisherError } from '../channels/github/publication/comment-publisher.ts';
import { GitHubIssueDeliveryError } from '../channels/github/publication/issue-delivery.ts';
import { GitHubNotificationPublicationError } from '../channels/github/publication/publication-contract.ts';
import { GitHubAccountClientError } from '../core/github-account-client.ts';
import { stateSnapshotConflictCode } from '../core/merge-state-snapshot.ts';
import {
  privateStateFileLockBusyErrorCode,
  privateStateFileLockLostErrorCode,
} from '../core/private-state-file-lock.ts';
import {
  type default as SessionDispatchCredential,
  type DispatchAuthority,
} from '../credentials/session-dispatch.ts';

import type { AgentManifest } from '../manifest/types.ts';
import GitCommandError from '../tools/git/command-error.ts';
import type TrustedGitWorktreeService from '../tools/git/trusted-worktree-service.ts';
import { revalidateFeedbackAssignment } from './assignment-feedback-reactivation.ts';
import { automationHash } from './automation-hash.ts';
import { inspectContinuedIssue, inspectAdmittedIssue } from './dispatch-assignment.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { type OpenClawDeliveryConnection } from './openclaw-delivery.ts';
import OpenClawDispatchStore, {
  type OpenClawDispatchState,
  type OpenClawDispatchRecord,
} from './openclaw-dispatch-state.ts';

import { type OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import { type IntakeObservation } from './openclaw-intake-report.ts';
import type OpenClawIntake from './openclaw-intake.ts';
import { type DispatchCaller } from './openclaw-session-create.ts';
import openclawTurnContext from './openclaw-turn-context.ts';
import retainedIntakePolicy from './retained-intake-policy.ts';

export interface OpenClawDispatchDependencies {
  readInstallationConfig?: typeof readInstallationConfig;
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

export default class OpenClawDispatchContext {
  constructor(readonly dependencies: OpenClawDispatchDependencies) {}
  async scope(manifest: AgentManifest, workspace: string) {
    const current = await this.dependencies.intake.select(manifest, workspace);
    await assertNotificationManagement(this.dependencies.root, current.store.location.scope);
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
  async validateLocal(
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
    if (record.retired || (record.retirement && record.retirement.reason !== 'assignment-removed'))
      throw new Error('dispatch-issue-inactive');
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
  guardedCredential(revalidate: () => Promise<unknown>): Pick<SessionDispatchCredential, 'use'> {
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
    const repo =
      (record.sessionCreation?.verified || record.effective?.status === 'verified') && !feedback
        ? (
            await inspectContinuedIssue(
              intake,
              client,
              liveManifest.github?.notifications?.issueAssignment?.allowed ?? [],
              record,
              (this.dependencies.now ?? Date.now)(),
            )
          ).repo
        : feedback
          ? await revalidateFeedbackAssignment(
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

  async reportScope(manifest: AgentManifest, workspace: string) {
    const current = await this.dependencies.intake.select(manifest, workspace);
    const state = await current.store.read();
    if (!state) throw new Error('dispatch-intake-record-missing');
    return {
      ...current,
      selected: current.selected ?? retainedIntakePolicy(manifest, state, 'openclaw'),
      journal: new OpenClawDispatchStore(this.dependencies.root, current.store.location.scope),
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
