import type { Logger } from '../../../../core/logger.ts';
import type { GitHubNotificationCommentReconcileOptions } from '../../conversation/comment-orchestrator.ts';
import type { GitHubNotificationExecutionSurface } from '../../conversation/execution.ts';
import type { GitHubNotificationItemSelector } from '../../provider/work-item.ts';
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
    selector: GitHubNotificationItemSelector | undefined,
    executionSurface: GitHubNotificationExecutionSurface,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = await this.#dependencies.stateStore.read(agentId);
    for (const itemKey of preparedGitHubNotificationIssueItemKeys(state, selector)) {
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
      }
    }
  }

  async reconcileCommentsSafely(
    agentId: string,
    selector: GitHubNotificationItemSelector | undefined,
    executionSurface: GitHubNotificationExecutionSurface,
    signal?: AbortSignal,
  ): Promise<{ code: string } | undefined> {
    try {
      await this.#reconcileComments(agentId, selector, executionSurface, signal);
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
  ): Promise<void> {
    const itemKeys = githubNotificationRetirementItemKeys(current);
    if (itemKeys.length === 0) {
      await this.#dependencies.stateStore.remove?.(agentId);
      return;
    }
    const retryDeferred =
      current?.nextPollAt !== undefined &&
      current.nextPollAt > now &&
      itemKeys.some((itemKey) => current.items[itemKey]?.intake?.failureCode !== undefined);
    if (retryDeferred) return;

    await this.reconcileAssignments(agentId, itemKeys, signal);
    const reconciled = await this.#dependencies.stateStore.read(agentId);
    if (githubNotificationRetirementItemKeys(reconciled).length === 0) {
      await this.#dependencies.stateStore.remove?.(agentId);
    }
  }

  async #reconcileComments(
    agentId: string,
    selector: GitHubNotificationItemSelector | undefined,
    executionSurface: GitHubNotificationExecutionSurface,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#dependencies.commentOrchestrator) return;
    const state = await this.#dependencies.stateStore.read(agentId);
    for (const itemKey of preparedGitHubNotificationIssueItemKeys(state, selector)) {
      if (signal?.aborted) return;
      await this.#dependencies.commentOrchestrator.reconcile(agentId, itemKey, {
        executionSurface,
        ...(signal === undefined ? {} : { signal }),
      });
    }
  }
}
