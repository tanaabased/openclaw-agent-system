import type { Logger } from '../../../../core/logger.ts';
import type { GitHubNotificationCommentReconcileOptions } from '../../conversation/comment-orchestrator.ts';
import type { GitHubNotificationExecutionSurface } from '../../conversation/execution.ts';
import { githubNotificationDiagnostic, githubNotificationToolCauseCode } from './diagnostic.ts';
import { preparedGitHubNotificationIssueItemKeys } from './item-queries.ts';
import {
  githubNotificationRetirementItemKeys,
  type GitHubNotificationMonitorState,
} from './state.ts';
import type GitHubNotificationMonitorStateStore from './state-store.ts';

export interface GitHubNotificationAssignmentReconciler {
  reconcile(agentId: string, itemKey: string, signal?: AbortSignal): Promise<void>;
  respond(
    agentId: string,
    itemKey: string,
    signal?: AbortSignal,
    executionSurface?: GitHubNotificationExecutionSurface,
  ): Promise<void>;
}

export interface GitHubNotificationCommentReconciler {
  reconcile(
    agentId: string,
    itemKey: string,
    options?: GitHubNotificationCommentReconcileOptions,
  ): Promise<void>;
}

export interface GitHubNotificationMonitorReconcilerDependencies {
  assignmentOrchestrator: GitHubNotificationAssignmentReconciler;
  commentOrchestrator?: GitHubNotificationCommentReconciler;
  logger: Logger;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read'> &
    Partial<Pick<GitHubNotificationMonitorStateStore, 'remove'>>;
}

/** Reconcile durable notification intake, responses, comments, and retirement. */
export default class GitHubNotificationMonitorReconciler {
  readonly #dependencies: GitHubNotificationMonitorReconcilerDependencies;

  constructor(dependencies: GitHubNotificationMonitorReconcilerDependencies) {
    this.#dependencies = dependencies;
  }

  async reconcileAssignments(
    agentId: string,
    itemKeys: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const itemKey of itemKeys) {
      if (signal?.aborted) return;
      await this.#dependencies.assignmentOrchestrator.reconcile(agentId, itemKey, signal);
    }
  }

  async reconcileAssignmentResponses(
    agentId: string,
    itemKey: string,
    executionSurface: GitHubNotificationExecutionSurface,
    signal?: AbortSignal,
  ): Promise<{ code: string } | undefined> {
    const state = await this.#dependencies.stateStore.read(agentId);
    if (preparedGitHubNotificationIssueItemKeys(state).includes(itemKey)) {
      if (signal?.aborted) return;
      try {
        await this.#dependencies.assignmentOrchestrator.respond(
          agentId,
          itemKey,
          signal,
          executionSurface,
        );
      } catch (error) {
        const diagnostic = githubNotificationDiagnostic(error);
        const causeCode = githubNotificationToolCauseCode(error);
        this.#dependencies.logger.warn(
          `github-notifications: assignment response reconciliation failed agent=${agentId} code=${diagnostic.code}${causeCode ? ` causeCode=${causeCode}` : ''}`,
        );
        return diagnostic;
      }
    }
  }

  async reconcileCommentsSafely(
    agentId: string,
    itemKey: string,
    executionSurface: GitHubNotificationExecutionSurface,
    signal?: AbortSignal,
  ): Promise<{ code: string } | undefined> {
    try {
      await this.#reconcileComments(agentId, itemKey, executionSurface, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const diagnostic = githubNotificationDiagnostic(error);
      this.#dependencies.logger.warn(
        `github-notifications: comment reconciliation failed agent=${agentId} code=${diagnostic.code}`,
      );
      return diagnostic;
    }
  }

  async retireDisabledAssignments(
    agentId: string,
    current: GitHubNotificationMonitorState | undefined,
    now: number,
    signal?: AbortSignal,
    itemKey?: string,
  ): Promise<void> {
    const remainingKeys = githubNotificationRetirementItemKeys(current);
    if (remainingKeys.length === 0) {
      await this.#dependencies.stateStore.remove?.(
        agentId,
        (latest) => githubNotificationRetirementItemKeys(latest).length === 0,
      );
      return;
    }
    const itemKeys =
      itemKey === undefined ? remainingKeys : remainingKeys.filter((key) => key === itemKey);
    const retryDeferred =
      current?.nextPollAt !== undefined &&
      current.nextPollAt > now &&
      itemKeys.some((itemKey) => current.items[itemKey]?.intake?.failureCode !== undefined);
    if (retryDeferred) return;

    await this.reconcileAssignments(agentId, itemKeys, signal);
    const reconciled = await this.#dependencies.stateStore.read(agentId);
    if (githubNotificationRetirementItemKeys(reconciled).length === 0) {
      await this.#dependencies.stateStore.remove?.(
        agentId,
        (latest) => githubNotificationRetirementItemKeys(latest).length === 0,
      );
    }
  }

  async #reconcileComments(
    agentId: string,
    itemKey: string,
    executionSurface: GitHubNotificationExecutionSurface,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#dependencies.commentOrchestrator) return;
    const state = await this.#dependencies.stateStore.read(agentId);
    if (preparedGitHubNotificationIssueItemKeys(state).includes(itemKey)) {
      if (signal?.aborted) return;
      await this.#dependencies.commentOrchestrator.reconcile(agentId, itemKey, {
        executionSurface,
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }
}
