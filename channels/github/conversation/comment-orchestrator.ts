import {
  deliverInboundReplyWithMessageSendContext,
  resolveMessageReceiptPrimaryId,
  type DurableInboundReplyDeliveryResult,
} from 'openclaw/plugin-sdk/channel-outbound';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationConversationId } from '../channel.ts';
import {
  admitGitHubComment,
  githubCommentRevision,
  type GitHubCanonicalIssueComment,
  type GitHubCommentRevision,
} from './comment-admission.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
  type GitHubNotificationCommentRevisionState,
  type GitHubNotificationConversationState,
} from './conversation-state.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
import { githubNotificationChannelId } from '../routing/routing.ts';
import type GitHubNotificationAssignmentProvider from '../intake/assignment-provider.ts';
import type GitHubNotificationLifecycleRegistry from '../lifecycles/registry.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';
import type GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import type GitHubNotificationCommentTurnService from './comment-turn-service.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type GitHubNotificationMonitorStateStore from '../intake/monitor/state-store.ts';

export interface GitHubNotificationCommentOrchestratorDependencies {
  assignmentAuthority: Pick<GitHubNotificationAssignmentProvider, 'open'>;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  deliver?: typeof deliverInboundReplyWithMessageSendContext;
  initialModeId: GitHubNotificationModeId;
  lifecycles: Pick<GitHubNotificationLifecycleRegistry, 'resolve'>;
  logger: Logger;
  monitorStateStore: Pick<GitHubNotificationMonitorStateStore, 'read'>;
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish'>;
  turns: Pick<GitHubNotificationCommentTurnService, 'respond'>;
}

export class GitHubNotificationCommentOrchestratorError extends Error {
  override name = 'GitHubNotificationCommentOrchestratorError';

  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super('The GitHub notification comment lifecycle could not be reconciled.', options);
  }
}

export interface GitHubNotificationCommentReconcileOptions {
  executionSurface: GitHubNotificationExecutionSurface;
  signal?: AbortSignal;
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
  return 'github-notification-comment-reconciliation-failed';
}

function publicationReceipt(result: DurableInboundReplyDeliveryResult): {
  databaseId: number;
  nodeId: string;
} {
  if (result.status !== 'handled_visible') {
    throw new GitHubNotificationCommentOrchestratorError(
      result.status === 'failed'
        ? 'github-notification-publication-failed'
        : 'github-notification-publication-not-confirmed',
      result.status === 'failed' ? { cause: result.error } : undefined,
    );
  }
  const receipt = result.delivery.receipt;
  const databaseIdText =
    (receipt ? resolveMessageReceiptPrimaryId(receipt) : undefined) ??
    result.delivery.messageIds?.[0];
  const nodeId = receipt?.parts.find((part) => part.platformMessageId === databaseIdText)?.raw?.meta
    ?.nodeId;
  const databaseId = Number(databaseIdText);
  if (!Number.isSafeInteger(databaseId) || databaseId < 1 || typeof nodeId !== 'string') {
    throw new GitHubNotificationCommentOrchestratorError(
      'github-notification-publication-receipt-invalid',
    );
  }
  return { databaseId, nodeId };
}

function sortedComments(comments: readonly GitHubCanonicalIssueComment[]) {
  return [...comments].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.databaseId - right.databaseId,
  );
}

/** Reconcile one prepared issue's bounded comment conversation. */
export default class GitHubNotificationCommentOrchestrator {
  readonly #deliver: typeof deliverInboundReplyWithMessageSendContext;
  readonly #dependencies: GitHubNotificationCommentOrchestratorDependencies;

  constructor(dependencies: GitHubNotificationCommentOrchestratorDependencies) {
    this.#dependencies = dependencies;
    this.#deliver = dependencies.deliver ?? deliverInboundReplyWithMessageSendContext;
  }

  async reconcile(
    agentId: string,
    itemKey: string,
    options: GitHubNotificationCommentReconcileOptions = { executionSurface: 'gateway' },
  ): Promise<void> {
    try {
      await this.#run(agentId, itemKey, options);
    } catch (error) {
      throw error instanceof GitHubNotificationCommentOrchestratorError
        ? error
        : new GitHubNotificationCommentOrchestratorError(errorCode(error), { cause: error });
    }
  }

  async #run(
    agentId: string,
    itemKey: string,
    options: GitHubNotificationCommentReconcileOptions,
  ): Promise<void> {
    const { executionSurface, signal } = options;
    const monitor = await this.#dependencies.monitorStateStore.read(agentId);
    const item = monitor?.items[itemKey];
    if (!monitor || !item || item.disposition !== 'approved' || item.intake?.stage !== 'prepared') {
      return;
    }
    const lifecycle = this.#dependencies.lifecycles.resolve(item.lifecycleId);
    if (!lifecycle.commentTurns.enabled) return;
    const conversationId = githubNotificationConversationId({
      itemNumber: item.number,
      lifecycleId: item.lifecycleId,
      repositoryId: item.repositoryNodeId,
    });
    let state =
      (await this.#dependencies.conversationStateStore.read(agentId)) ??
      createGitHubNotificationConversationState(agentId, monitor.workspaceDir);
    if (state.workspaceDir !== monitor.workspaceDir) {
      throw new GitHubNotificationCommentOrchestratorError(
        'github-notification-conversation-workspace-mismatch',
      );
    }
    const existingConversation = state.conversations[conversationId];
    if (existingConversation) {
      const pending = Object.entries(existingConversation.revisions).find(
        ([, revision]) =>
          revision.status === 'responded' && revision.publication?.status === 'pending',
      );
      if (pending) {
        const [commentNodeId, revision] = pending;
        await this.#retryPublication(agentId, conversationId, commentNodeId, revision, signal);
        return;
      }
    }

    const opened = await this.#dependencies.assignmentAuthority.open({
      agentId,
      intake: item.intake,
      item,
      ...(signal === undefined ? {} : { signal }),
      workspaceDir: monitor.workspaceDir,
    });
    if (!opened.authorized) {
      throw new GitHubNotificationCommentOrchestratorError(
        opened.reasonCode ?? 'github-notification-comment-authority-revoked',
      );
    }
    const page = await opened.client.listIssueComments(
      item.repositoryOwner,
      item.repositoryName,
      item.number,
    );
    if (page.truncated) {
      throw new GitHubNotificationCommentOrchestratorError(
        'github-notification-comments-truncated',
      );
    }
    if (!existingConversation) {
      const revisions = Object.fromEntries(
        sortedComments(page.comments).map((comment) => {
          const revision = githubCommentRevision(comment);
          return [
            comment.nodeId,
            {
              bodyDigest: revision.bodyDigest,
              commentDatabaseId: comment.databaseId,
              reasonCode: 'comment-baseline',
              revisionId: revision.revisionId,
              status: 'baseline' as const,
            },
          ];
        }),
      );
      state = structuredClone(state);
      state.conversations[conversationId] = {
        baselineEstablished: true,
        itemKey,
        lifecycleId: item.lifecycleId,
        mode: this.#dependencies.initialModeId,
        revisions,
      };
      await this.#dependencies.conversationStateStore.write(state);
      this.#dependencies.logger.info(
        `github-notifications: comment baseline established agent=${agentId} item=${itemKey} comments=${page.comments.length}`,
      );
      return;
    }

    for (const observed of sortedComments(page.comments)) {
      const observedRevision = githubCommentRevision(observed);
      const current = existingConversation.revisions[observed.nodeId];
      if (current?.revisionId === observedRevision.revisionId && current.status !== 'admitted') {
        continue;
      }
      const exact = await opened.client.getIssueComment(
        item.repositoryOwner,
        item.repositoryName,
        item.number,
        observed.databaseId,
      );
      const exactRevision = githubCommentRevision(exact);
      if (
        exact.nodeId !== observed.nodeId ||
        exactRevision.revisionId !== observedRevision.revisionId
      ) {
        throw new GitHubNotificationCommentOrchestratorError(
          'github-notification-comment-revision-changed',
        );
      }
      const admission = admitGitHubComment({
        account: opened.client.identity,
        comment: exact,
        configuration: opened.configuration,
      });
      if (admission.disposition !== 'approved') {
        await this.#checkpointRevision(agentId, conversationId, exact.nodeId, {
          bodyDigest: exactRevision.bodyDigest,
          commentDatabaseId: exact.databaseId,
          reasonCode: admission.code,
          revisionId: exactRevision.revisionId,
          status: 'rejected',
        });
        continue;
      }
      await this.#checkpointRevision(agentId, conversationId, exact.nodeId, {
        bodyDigest: exactRevision.bodyDigest,
        commentDatabaseId: exact.databaseId,
        reasonCode: admission.code,
        revisionId: exactRevision.revisionId,
        status: 'admitted',
      });
      await this.#respond(
        agentId,
        conversationId,
        executionSurface,
        exact,
        exactRevision,
        item,
        existingConversation.mode,
        monitor.workspaceDir,
        signal,
      );
      return;
    }
  }

  async #respond(
    agentId: string,
    conversationId: string,
    executionSurface: GitHubNotificationExecutionSurface,
    comment: GitHubCanonicalIssueComment,
    revision: GitHubCommentRevision,
    item: GitHubNotificationItemState,
    modeId: GitHubNotificationModeId,
    workspaceDir: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let response;
    try {
      response = await this.#dependencies.turns.respond({
        agentId,
        comment,
        executionSurface,
        item,
        modeId,
        revision,
        ...(signal === undefined ? {} : { signal }),
        workspaceDir,
      });
    } catch (error) {
      await this.#checkpointRevision(agentId, conversationId, comment.nodeId, {
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: comment.databaseId,
        failureCode: errorCode(error),
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        status: 'admitted',
      });
      throw error;
    }
    if (response.publication.status === 'withheld') {
      await this.#checkpointRevision(agentId, conversationId, comment.nodeId, {
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: comment.databaseId,
        publication: { reasonCode: response.publication.code, status: 'withheld' },
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        status: 'responded',
      });
      this.#dependencies.logger.warn(
        [
          'github-notifications: comment publication withheld',
          `agent=${agentId}`,
          `item=${item.repositoryOwner}/${item.repositoryName}#${item.number}`,
          `revision=${revision.revisionId}`,
          `code=${response.publication.code}`,
        ].join(' '),
      );
      return;
    }
    const source = { commentDatabaseId: comment.databaseId, revisionId: revision.revisionId };
    const target = githubNotificationPublicationTarget({
      intent: 'github-reply',
      item,
      source,
    });
    await this.#checkpointRevision(agentId, conversationId, comment.nodeId, {
      bodyDigest: revision.bodyDigest,
      commentDatabaseId: comment.databaseId,
      publication: {
        publicText: response.publication.publicText,
        publicTextDigest: githubNotificationPublicTextDigest(response.publication.publicText),
        status: 'pending',
        target,
      },
      reasonCode: 'comment-approved',
      revisionId: revision.revisionId,
      status: 'responded',
    });
    const delivered = await this.#deliver({
      accountId: response.accountId,
      agentId: response.agentId,
      cfg: response.config,
      channel: githubNotificationChannelId,
      ctxPayload: response.ctxPayload,
      info: { kind: 'final' },
      payload: { text: response.publication.publicText },
      requiredCapabilities: { reconcileUnknownSend: true, text: true },
      to: target,
    });
    const receipt = publicationReceipt(delivered);
    await this.#checkpointPublished(
      agentId,
      conversationId,
      comment.nodeId,
      revision.revisionId,
      receipt,
    );
  }

  async #retryPublication(
    agentId: string,
    conversationId: string,
    commentNodeId: string,
    revision: GitHubNotificationCommentRevisionState,
    signal?: AbortSignal,
  ): Promise<void> {
    const publication = revision.publication;
    if (!publication || publication.status !== 'pending') return;
    const result = await this.#dependencies.publications.publish({
      accountId: agentId,
      ...(signal === undefined ? {} : { signal }),
      target: publication.target,
      text: publication.publicText,
    });
    await this.#checkpointPublished(
      agentId,
      conversationId,
      commentNodeId,
      revision.revisionId,
      result.receipt,
    );
  }

  async #checkpointPublished(
    agentId: string,
    conversationId: string,
    commentNodeId: string,
    revisionId: string,
    receipt: { databaseId: number; nodeId: string },
  ): Promise<void> {
    const current = await this.#dependencies.conversationStateStore.read(agentId);
    const revision = current?.conversations[conversationId]?.revisions[commentNodeId];
    if (
      !current ||
      revision?.revisionId !== revisionId ||
      !revision.publication ||
      revision.publication.status !== 'pending'
    ) {
      return;
    }
    const state = structuredClone(current);
    state.conversations[conversationId]!.revisions[commentNodeId] = {
      ...revision,
      publication: {
        ...revision.publication,
        commentDatabaseId: receipt.databaseId,
        commentNodeId: receipt.nodeId,
        status: 'published',
      },
    };
    await this.#dependencies.conversationStateStore.write(state);
  }

  async #checkpointRevision(
    agentId: string,
    conversationId: string,
    commentNodeId: string,
    revision: GitHubNotificationCommentRevisionState,
  ): Promise<GitHubNotificationConversationState> {
    const current = await this.#dependencies.conversationStateStore.read(agentId);
    const conversation = current?.conversations[conversationId];
    if (!current || !conversation) {
      throw new GitHubNotificationCommentOrchestratorError(
        'github-notification-conversation-state-missing',
      );
    }
    const state = structuredClone(current);
    state.conversations[conversationId]!.revisions[commentNodeId] = revision;
    await this.#dependencies.conversationStateStore.write(state);
    return state;
  }
}
