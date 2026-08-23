import { KeyedAsyncQueue } from 'openclaw/plugin-sdk/keyed-async-queue';
import { deliverInboundReplyWithMessageSendContext } from 'openclaw/plugin-sdk/channel-outbound';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationConversationId } from '../channel.ts';
import type { GitHubNotificationAssignmentProviderAuthority } from '../intake/assignment-provider.ts';
import type GitHubNotificationMonitorStateStore from '../intake/monitor/state-store.ts';
import type GitHubNotificationLifecycleRegistry from '../lifecycles/registry.ts';
import type { GitHubNotificationMode } from '../modes/types.ts';
import type { GitHubNotificationItemContextClient } from '../provider/work-event-client.ts';
import type GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import { githubNotificationDurableDeliveryReceipt } from '../publication/durable-delivery.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
import { githubNotificationChannelId } from '../routing/routing.ts';
import type GitHubNotificationAssignmentTurnService from './assignment-turn-service.ts';
import {
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversationState,
} from './conversation-state.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type GitHubNotificationTurnCatalog from './turn-catalog.ts';

export interface GitHubNotificationAssignmentResponseOrchestratorDependencies {
  assignmentAuthority: GitHubNotificationAssignmentProviderAuthority<GitHubNotificationItemContextClient>;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  deliver?: typeof deliverInboundReplyWithMessageSendContext;
  initialMode: Pick<GitHubNotificationMode, 'policy'>;
  lifecycles: Pick<GitHubNotificationLifecycleRegistry, 'resolve'>;
  logger: Logger;
  monitorStateStore: Pick<GitHubNotificationMonitorStateStore, 'read'>;
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish'>;
  turnCatalog: Pick<GitHubNotificationTurnCatalog, 'resolve'>;
  turns: Pick<GitHubNotificationAssignmentTurnService, 'respond'>;
}

export interface GitHubNotificationAssignmentResponseReconcileOptions {
  executionSurface: GitHubNotificationExecutionSurface;
  signal?: AbortSignal;
}

export class GitHubNotificationAssignmentResponseOrchestratorError extends Error {
  override name = 'GitHubNotificationAssignmentResponseOrchestratorError';

  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super('The GitHub assignment response could not be reconciled.', options);
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
  return 'github-notification-assignment-response-failed';
}

/** Reconcile the model-backed response for one prepared assignment. */
export default class GitHubNotificationAssignmentResponseOrchestrator {
  readonly #deliver: typeof deliverInboundReplyWithMessageSendContext;
  readonly #dependencies: GitHubNotificationAssignmentResponseOrchestratorDependencies;
  readonly #queue = new KeyedAsyncQueue();

  constructor(dependencies: GitHubNotificationAssignmentResponseOrchestratorDependencies) {
    this.#dependencies = dependencies;
    this.#deliver = dependencies.deliver ?? deliverInboundReplyWithMessageSendContext;
  }

  async reconcile(
    agentId: string,
    itemKey: string,
    options: GitHubNotificationAssignmentResponseReconcileOptions = {
      executionSurface: 'gateway',
    },
  ): Promise<void> {
    return this.#queue.enqueue(agentId, async () => {
      try {
        await this.#run(agentId, itemKey, options);
      } catch (error) {
        throw error instanceof GitHubNotificationAssignmentResponseOrchestratorError
          ? error
          : new GitHubNotificationAssignmentResponseOrchestratorError(errorCode(error), {
              cause: error,
            });
      }
    });
  }

  async #run(
    agentId: string,
    itemKey: string,
    options: GitHubNotificationAssignmentResponseReconcileOptions,
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
      throw new GitHubNotificationAssignmentResponseOrchestratorError(
        'github-notification-assignment-response-state-missing',
      );
    }
    if (conversation.assignmentResponse?.publication.status === 'published') return;
    if (conversation.assignmentResponse?.publication.status === 'pending') {
      await this.#retryPublication(
        agentId,
        conversationId,
        conversation.assignmentResponse.sourceId,
        conversation.assignmentResponse.publication.target,
        conversation.assignmentResponse.publication.publicText,
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
      throw new GitHubNotificationAssignmentResponseOrchestratorError(
        'github-notification-assignment-response-worktree-missing',
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
      throw new GitHubNotificationAssignmentResponseOrchestratorError(
        opened.reasonCode ?? 'github-notification-assignment-response-authority-revoked',
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
    if (response.publication.status !== 'candidate') {
      throw new GitHubNotificationAssignmentResponseOrchestratorError(
        response.publication.status === 'withheld'
          ? response.publication.code
          : 'github-notification-assignment-assignment-response-missing',
      );
    }
    const target = githubNotificationPublicationTarget({
      intent: 'assignment-response',
      item,
      publicationId: intake.assignmentEventId,
    });
    await this.#checkpointPending(
      agentId,
      conversationId,
      intake.assignmentEventId,
      response.publication.publicText,
      target,
    );
    await this.#deliverResponse(
      agentId,
      conversationId,
      intake.assignmentEventId,
      target,
      response.publication.publicText,
      response,
    );
    this.#dependencies.logger.info(
      `github-notifications: assignment response published agent=${agentId} item=${itemKey}`,
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
    publicText: string,
    target: string,
  ): Promise<void> {
    const current = await this.#dependencies.conversationStateStore.read(agentId);
    const conversation = current?.conversations[conversationId];
    if (!current || conversation?.activeTurn?.sourceId !== sourceId) {
      throw new GitHubNotificationAssignmentResponseOrchestratorError(
        'github-notification-assignment-response-turn-missing',
      );
    }
    const next = structuredClone(current);
    const updated = next.conversations[conversationId]!;
    delete updated.activeTurn;
    updated.assignmentResponse = {
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

  async #deliverResponse(
    agentId: string,
    conversationId: string,
    sourceId: string,
    target: string,
    publicText: string,
    response: Awaited<ReturnType<GitHubNotificationAssignmentTurnService['respond']>>,
  ): Promise<void> {
    const delivered = await this.#deliver({
      accountId: response.accountId,
      agentId: response.agentId,
      cfg: response.config,
      channel: githubNotificationChannelId,
      ctxPayload: response.ctxPayload,
      info: { kind: 'final' },
      payload: { text: publicText },
      requiredCapabilities: { reconcileUnknownSend: true, text: true },
      to: target,
    });
    await this.#checkpointPublished(
      agentId,
      conversationId,
      sourceId,
      target,
      githubNotificationDurableDeliveryReceipt(delivered),
    );
  }

  async #retryPublication(
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
    await this.#checkpointPublished(agentId, conversationId, sourceId, target, result.receipt);
  }

  async #checkpointPublished(
    agentId: string,
    conversationId: string,
    sourceId: string,
    target: string,
    receipt: { databaseId: number; nodeId: string },
  ): Promise<void> {
    const current = await this.#dependencies.conversationStateStore.read(agentId);
    const assignmentResponse = current?.conversations[conversationId]?.assignmentResponse;
    if (
      !current ||
      assignmentResponse?.sourceId !== sourceId ||
      assignmentResponse.publication.target !== target
    ) {
      throw new GitHubNotificationAssignmentResponseOrchestratorError(
        'github-notification-assignment-response-checkpoint-missing',
      );
    }
    if (assignmentResponse.publication.status === 'published') return;
    const next = structuredClone(current);
    next.conversations[conversationId]!.assignmentResponse = {
      ...assignmentResponse,
      publication: {
        ...assignmentResponse.publication,
        commentDatabaseId: receipt.databaseId,
        commentNodeId: receipt.nodeId,
        status: 'published',
      },
    };
    await this.#dependencies.conversationStateStore.write(next);
  }
}
