import { KeyedAsyncQueue } from 'openclaw/plugin-sdk/keyed-async-queue';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationConversationId } from '../channel.ts';
import type { GitHubNotificationAssignmentProviderAuthority } from '../intake/assignment-provider.ts';
import type GitHubNotificationMonitorStateStore from '../intake/monitor/state-store.ts';
import type GitHubNotificationLifecycleRegistry from '../lifecycles/registry.ts';
import type { GitHubNotificationMode } from '../modes/types.ts';
import type { GitHubNotificationItemContextClient } from '../provider/work-event-client.ts';
import type GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
import type GitHubNotificationAssignmentTurnService from './assignment-turn-service.ts';
import {
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversationState,
} from './conversation-state.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type GitHubNotificationTurnCatalog from './turn-catalog.ts';

export interface GitHubNotificationAssignmentPlanningOrchestratorDependencies {
  assignmentAuthority: GitHubNotificationAssignmentProviderAuthority<GitHubNotificationItemContextClient>;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  initialMode: Pick<GitHubNotificationMode, 'policy'>;
  lifecycles: Pick<GitHubNotificationLifecycleRegistry, 'resolve'>;
  logger: Logger;
  monitorStateStore: Pick<GitHubNotificationMonitorStateStore, 'read'>;
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish'>;
  turnCatalog: Pick<GitHubNotificationTurnCatalog, 'resolve'>;
  turns: Pick<GitHubNotificationAssignmentTurnService, 'respond'>;
}

export interface GitHubNotificationAssignmentPlanningReconcileOptions {
  executionSurface: GitHubNotificationExecutionSurface;
  signal?: AbortSignal;
}

export class GitHubNotificationAssignmentPlanningOrchestratorError extends Error {
  override name = 'GitHubNotificationAssignmentPlanningOrchestratorError';

  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super('The GitHub assignment planning lifecycle could not be reconciled.', options);
  }
}

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('github-notification-')
  ) {
    return error.code;
  }
  return 'github-notification-assignment-planning-failed';
}

/** Reconcile the current model-backed planning outcome for one prepared assignment. */
export default class GitHubNotificationAssignmentPlanningOrchestrator {
  readonly #dependencies: GitHubNotificationAssignmentPlanningOrchestratorDependencies;
  readonly #queue = new KeyedAsyncQueue();

  constructor(dependencies: GitHubNotificationAssignmentPlanningOrchestratorDependencies) {
    this.#dependencies = dependencies;
  }

  async reconcile(
    agentId: string,
    itemKey: string,
    options: GitHubNotificationAssignmentPlanningReconcileOptions = {
      executionSurface: 'gateway',
    },
  ): Promise<void> {
    return this.#queue.enqueue(agentId, async () => {
      try {
        await this.#run(agentId, itemKey, options);
      } catch (error) {
        throw error instanceof GitHubNotificationAssignmentPlanningOrchestratorError
          ? error
          : new GitHubNotificationAssignmentPlanningOrchestratorError(errorCode(error), {
              cause: error,
            });
      }
    });
  }

  async #run(
    agentId: string,
    itemKey: string,
    options: GitHubNotificationAssignmentPlanningReconcileOptions,
  ): Promise<void> {
    const monitor = await this.#dependencies.monitorStateStore.read(agentId);
    const item = monitor?.items[itemKey];
    const intake = item?.intake;
    if (
      !monitor ||
      !item ||
      !intake ||
      item.disposition !== 'approved' ||
      item.lifecycleId !== 'issue' ||
      intake.stage !== 'prepared'
    ) {
      return;
    }
    const conversationId = githubNotificationConversationId({
      itemNumber: item.number,
      lifecycleId: item.lifecycleId,
      repositoryId: item.repositoryNodeId,
    });
    const state = await this.#dependencies.conversationStateStore.read(agentId);
    const conversation = state?.conversations[conversationId];
    if (
      !state ||
      !conversation ||
      state.workspaceDir !== monitor.workspaceDir ||
      conversation.itemKey !== itemKey ||
      conversation.lifecycleId !== item.lifecycleId ||
      conversation.mode !== this.#dependencies.initialMode.policy.id
    ) {
      throw new GitHubNotificationAssignmentPlanningOrchestratorError(
        'github-notification-assignment-planning-state-missing',
      );
    }
    if (conversation.planning?.publication.status === 'published') return;
    if (conversation.planning?.publication.status === 'pending') {
      await this.#publish(
        agentId,
        conversationId,
        conversation.planning.sourceId,
        conversation.planning.publication.target,
        conversation.planning.publication.publicText,
        options.signal,
      );
      return;
    }

    this.#dependencies.turnCatalog.resolve({
      eventId: 'assignment',
      lifecycleId: item.lifecycleId,
      modeId: conversation.mode,
    });
    const lifecycle = this.#dependencies.lifecycles.resolve(item.lifecycleId);
    if (!intake.worktreeBranch || !intake.worktreePath) {
      throw new GitHubNotificationAssignmentPlanningOrchestratorError(
        'github-notification-assignment-planning-worktree-missing',
      );
    }
    const opened = await this.#dependencies.assignmentAuthority.open({
      agentId,
      intake,
      item,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      workspaceDir: monitor.workspaceDir,
    });
    if (!opened.authorized) {
      throw new GitHubNotificationAssignmentPlanningOrchestratorError(
        opened.reasonCode ?? 'github-notification-assignment-planning-authority-revoked',
      );
    }
    const itemContext = await opened.client.getItemContext(
      item.repositoryOwner,
      item.repositoryName,
      item.number,
      item.itemType,
    );
    await this.#checkpointActive(state, conversationId, intake.assignmentEventId);
    const response = await this.#dependencies.turns.respond({
      agentId,
      executionSurface: options.executionSurface,
      item,
      itemContext,
      lifecycle,
      mode: this.#dependencies.initialMode,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      sourceId: intake.assignmentEventId,
      workspaceDir: monitor.workspaceDir,
      worktree: { branch: intake.worktreeBranch, path: intake.worktreePath },
    });
    if (
      response.publication.status !== 'candidate' ||
      response.publication.planningOutcome === undefined
    ) {
      throw new GitHubNotificationAssignmentPlanningOrchestratorError(
        response.publication.status === 'withheld'
          ? response.publication.code
          : 'github-notification-assignment-planning-outcome-missing',
      );
    }
    const target = githubNotificationPublicationTarget({
      intent: 'planning-outcome',
      item,
      publicationId: intake.assignmentEventId,
    });
    await this.#checkpointPending(
      agentId,
      conversationId,
      intake.assignmentEventId,
      response.publication.planningOutcome,
      response.publication.publicText,
      target,
    );
    await this.#publish(
      agentId,
      conversationId,
      intake.assignmentEventId,
      target,
      response.publication.publicText,
      options.signal,
    );
    this.#dependencies.logger.info(
      `github-notifications: assignment planning published agent=${agentId} item=${itemKey} outcome=${response.publication.planningOutcome}`,
    );
  }

  async #checkpointActive(
    current: GitHubNotificationConversationState,
    conversationId: string,
    sourceId: string,
  ): Promise<void> {
    const next = structuredClone(current);
    next.conversations[conversationId]!.activeTurn = { eventId: 'assignment', sourceId };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #checkpointPending(
    agentId: string,
    conversationId: string,
    sourceId: string,
    outcome: 'plan' | 'questions',
    publicText: string,
    target: string,
  ): Promise<void> {
    const current = await this.#dependencies.conversationStateStore.read(agentId);
    const conversation = current?.conversations[conversationId];
    if (!current || conversation?.activeTurn?.sourceId !== sourceId) {
      throw new GitHubNotificationAssignmentPlanningOrchestratorError(
        'github-notification-assignment-planning-turn-missing',
      );
    }
    const next = structuredClone(current);
    const updated = next.conversations[conversationId]!;
    delete updated.activeTurn;
    updated.planning = {
      outcome,
      publication: {
        publicText,
        publicTextDigest: githubNotificationPublicTextDigest(publicText),
        status: 'pending',
        target,
      },
      sourceId,
    };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #publish(
    agentId: string,
    conversationId: string,
    sourceId: string,
    target: string,
    publicText: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.#dependencies.publications.publish({
      accountId: agentId,
      ...(signal === undefined ? {} : { signal }),
      target,
      text: publicText,
    });
    const current = await this.#dependencies.conversationStateStore.read(agentId);
    const planning = current?.conversations[conversationId]?.planning;
    if (!current || planning?.sourceId !== sourceId || planning.publication.target !== target) {
      throw new GitHubNotificationAssignmentPlanningOrchestratorError(
        'github-notification-assignment-planning-checkpoint-missing',
      );
    }
    if (planning.publication.status === 'published') return;
    const next = structuredClone(current);
    next.conversations[conversationId]!.planning = {
      ...planning,
      publication: {
        ...planning.publication,
        commentDatabaseId: result.receipt.databaseId,
        commentNodeId: result.receipt.nodeId,
        status: 'published',
      },
    };
    await this.#dependencies.conversationStateStore.write(next);
  }
}
