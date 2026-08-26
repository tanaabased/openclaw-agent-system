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
  type GitHubCommentMention,
  type GitHubCommentRevision,
} from './comment-admission.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
  type GitHubNotificationCommentRevisionState,
  type GitHubNotificationConversationSource,
  type GitHubNotificationConversationState,
} from './conversation-state.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
import { githubNotificationChannelId } from '../routing/routing.ts';
import type { GitHubNotificationAssignmentProviderAuthority } from '../intake/assignment-provider.ts';
import type GitHubNotificationLifecycleRegistry from '../lifecycles/registry.ts';
import { githubNotificationLifecycleSupportsEvent } from '../lifecycles/event-support.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';
import type GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import type GitHubNotificationCommentTurnService from './comment-turn-service.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type GitHubNotificationMonitorStateStore from '../intake/monitor/state-store.ts';
import type GitHubNotificationTurnCatalog from './turn-catalog.ts';
import type {
  GitHubNotificationCommentClient,
  GitHubNotificationIntakeClient,
} from '../provider/work-event-client.ts';

type GitHubNotificationConversationClient = GitHubNotificationCommentClient &
  Pick<GitHubNotificationIntakeClient, 'getItem'>;

export interface GitHubNotificationCommentOrchestratorDependencies {
  assignmentAuthority: GitHubNotificationAssignmentProviderAuthority<GitHubNotificationConversationClient>;
  clock?: () => number;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  deliver?: typeof deliverInboundReplyWithMessageSendContext;
  initialModeId: GitHubNotificationModeId;
  lifecycles: Pick<GitHubNotificationLifecycleRegistry, 'resolve'>;
  logger: Logger;
  monitorStateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish'>;
  turnCatalog: Pick<GitHubNotificationTurnCatalog, 'resolve'>;
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

interface GitHubNotificationCommentSource extends GitHubNotificationConversationSource {
  baselineEstablished: boolean;
  pullRequestNodeId?: string;
}

interface GitHubNotificationObservedComment {
  comment: GitHubCanonicalIssueComment;
  source: GitHubNotificationCommentSource;
}

function sortedComments(comments: readonly GitHubNotificationObservedComment[]) {
  return [...comments].sort(
    (left, right) =>
      Date.parse(left.comment.createdAt) - Date.parse(right.comment.createdAt) ||
      left.comment.databaseId - right.comment.databaseId,
  );
}

/** Reconcile one prepared lifecycle item's bounded comment conversation. */
export default class GitHubNotificationCommentOrchestrator {
  readonly #clock: () => number;
  readonly #deliver: typeof deliverInboundReplyWithMessageSendContext;
  readonly #dependencies: GitHubNotificationCommentOrchestratorDependencies;

  constructor(dependencies: GitHubNotificationCommentOrchestratorDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? Date.now;
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
    if (!githubNotificationLifecycleSupportsEvent(lifecycle, 'comment')) return;
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
    const modeId = existingConversation?.mode ?? this.#dependencies.initialModeId;
    this.#dependencies.turnCatalog.resolve({
      eventId: 'comment',
      lifecycleId: item.lifecycleId,
      modeId,
    });

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
    if (
      existingConversation &&
      (await this.#reconcileDeliveryPullRequest(
        agentId,
        conversationId,
        itemKey,
        item,
        opened.client,
      ))
    ) {
      return;
    }
    const sources: GitHubNotificationCommentSource[] = [
      {
        baselineEstablished: existingConversation?.baselineEstablished ?? false,
        itemType: item.itemType,
        number: item.number,
      },
      ...(existingConversation?.deliveryPullRequest?.status === 'open'
        ? [
            {
              baselineEstablished: existingConversation.deliveryPullRequest.baselineEstablished,
              itemType: 'pull-request' as const,
              number: existingConversation.deliveryPullRequest.number,
              pullRequestNodeId: existingConversation.deliveryPullRequest.nodeId,
            },
          ]
        : []),
    ];
    const pages: Array<{
      comments: GitHubCanonicalIssueComment[];
      source: GitHubNotificationCommentSource;
    }> = [];
    for (const source of sources) {
      const page = await opened.client.listIssueComments(
        item.repositoryOwner,
        item.repositoryName,
        source.number,
      );
      if (page.truncated) {
        throw new GitHubNotificationCommentOrchestratorError(
          'github-notification-comments-truncated',
        );
      }
      pages.push({ comments: page.comments, source });
    }
    const missingBaselines = pages.filter(({ source }) => !source.baselineEstablished);
    if (missingBaselines.length > 0) {
      state = structuredClone(state);
      state.conversations[conversationId] = {
        ...(existingConversation ?? {}),
        baselineEstablished: existingConversation?.baselineEstablished ?? false,
        itemKey,
        lifecycleId: item.lifecycleId,
        mode: modeId,
        revisions: { ...(existingConversation?.revisions ?? {}) },
      };
      const conversation = state.conversations[conversationId]!;
      let baselineCount = 0;
      for (const { comments, source } of missingBaselines) {
        for (const comment of comments) {
          const revision = githubCommentRevision(comment);
          conversation.revisions[comment.nodeId] = {
            bodyDigest: revision.bodyDigest,
            commentDatabaseId: comment.databaseId,
            reasonCode: 'comment-baseline',
            revisionId: revision.revisionId,
            source: { itemType: source.itemType, number: source.number },
            status: 'baseline',
          };
          baselineCount += 1;
        }
        if (source.pullRequestNodeId) {
          const pullRequest = conversation.deliveryPullRequest;
          if (
            !pullRequest ||
            pullRequest.nodeId !== source.pullRequestNodeId ||
            pullRequest.number !== source.number ||
            pullRequest.status !== 'open'
          ) {
            throw new GitHubNotificationCommentOrchestratorError(
              'github-notification-comment-source-changed',
            );
          }
          pullRequest.baselineEstablished = true;
        } else {
          conversation.baselineEstablished = true;
        }
      }
      await this.#dependencies.conversationStateStore.write(state);
      this.#dependencies.logger.info(
        `github-notifications: comment baseline established agent=${agentId} item=${itemKey} sources=${missingBaselines.length} comments=${baselineCount}`,
      );
      return;
    }

    const observations = sortedComments(
      pages.flatMap(({ comments, source }) => comments.map((comment) => ({ comment, source }))),
    );
    for (const { comment: observed, source } of observations) {
      const observedRevision = githubCommentRevision(observed);
      const current = existingConversation!.revisions[observed.nodeId];
      if (current?.revisionId === observedRevision.revisionId && current.status !== 'admitted') {
        continue;
      }
      const exact = await opened.client.getIssueComment(
        item.repositoryOwner,
        item.repositoryName,
        source.number,
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
          source: { itemType: source.itemType, number: source.number },
          status: 'rejected',
        });
        continue;
      }
      await this.#checkpointRevision(agentId, conversationId, exact.nodeId, {
        bodyDigest: exactRevision.bodyDigest,
        commentDatabaseId: exact.databaseId,
        reasonCode: admission.code,
        revisionId: exactRevision.revisionId,
        source: { itemType: source.itemType, number: source.number },
        status: 'admitted',
      });
      await this.#respond(
        agentId,
        conversationId,
        executionSurface,
        exact,
        admission.mentions,
        exactRevision,
        item,
        modeId,
        { itemType: source.itemType, number: source.number },
        monitor.workspaceDir,
        signal,
      );
      return;
    }
  }

  async #reconcileDeliveryPullRequest(
    agentId: string,
    conversationId: string,
    itemKey: string,
    item: GitHubNotificationItemState,
    client: GitHubNotificationConversationClient,
  ): Promise<boolean> {
    const current = await this.#dependencies.conversationStateStore.read(agentId);
    const conversation = current?.conversations[conversationId];
    if (!current || !conversation) return false;
    const next = structuredClone(current);
    const updated = next.conversations[conversationId]!;
    const source = conversation.deliveryPullRequest;
    if (!source || source.status === 'merged') return false;
    const observed = await client.getItem(item.repositoryOwner, item.repositoryName, source.number);
    if (
      observed.itemType !== 'pull-request' ||
      observed.nodeId !== source.nodeId ||
      observed.databaseId !== source.itemDatabaseId ||
      observed.number !== source.number
    ) {
      throw new GitHubNotificationCommentOrchestratorError(
        'github-notification-comment-source-changed',
      );
    }
    const status = observed.pullRequest.merged
      ? 'merged'
      : observed.state === 'closed'
        ? 'closed'
        : 'open';
    if (status === source.status) return false;
    const updatedSource = updated.deliveryPullRequest!;
    updatedSource.status = status;
    if (status !== 'open' || source.status === 'closed') {
      updatedSource.baselineEstablished = false;
    }
    const merged = status === 'merged';
    if (merged) {
      const monitor = await this.#dependencies.monitorStateStore.read(agentId);
      const monitorItem = monitor?.items[itemKey];
      if (!monitor || !monitorItem?.intake || monitorItem.intake.stage !== 'prepared') {
        throw new GitHubNotificationCommentOrchestratorError(
          'github-notification-comment-retirement-state-missing',
        );
      }
      const retired = structuredClone(monitor);
      retired.items[itemKey] = {
        ...monitorItem,
        disposition: 'retired',
        intake: {
          ...monitorItem.intake,
          providerRetirementVerifiedAt: this.#clock(),
          stage: 'retired',
        },
        reasonCode: 'pull-request-merged',
      };
      await this.#dependencies.monitorStateStore.write(retired);
    }
    await this.#dependencies.conversationStateStore.write(next);
    this.#dependencies.logger.info(
      `github-notifications: delivery pull request state reconciled agent=${agentId} item=${itemKey} retired=${merged}`,
    );
    return true;
  }

  async #respond(
    agentId: string,
    conversationId: string,
    executionSurface: GitHubNotificationExecutionSurface,
    comment: GitHubCanonicalIssueComment,
    mentions: readonly GitHubCommentMention[],
    revision: GitHubCommentRevision,
    item: GitHubNotificationItemState,
    modeId: GitHubNotificationModeId,
    source: GitHubNotificationConversationSource,
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
        mentions,
        modeId,
        revision,
        ...(signal === undefined ? {} : { signal }),
        source,
        workspaceDir,
      });
    } catch (error) {
      await this.#checkpointRevision(agentId, conversationId, comment.nodeId, {
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: comment.databaseId,
        failureCode: errorCode(error),
        reasonCode: 'comment-approved',
        revisionId: revision.revisionId,
        source,
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
        source,
        status: 'responded',
      });
      this.#dependencies.logger.warn(
        [
          'github-notifications: comment publication withheld',
          `agent=${agentId}`,
          `item=${item.repositoryOwner}/${item.repositoryName}#${source.number}`,
          `revision=${revision.revisionId}`,
          `code=${response.publication.code}`,
        ].join(' '),
      );
      return;
    }
    const publicationSource = {
      commentDatabaseId: comment.databaseId,
      revisionId: revision.revisionId,
    };
    const target = githubNotificationPublicationTarget({
      intent: 'github-reply',
      item,
      source: publicationSource,
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
      source,
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
    const updatedConversation = state.conversations[conversationId]!;
    if (revision.status === 'admitted') {
      updatedConversation.activeTurn = {
        eventId: 'comment',
        sourceId: revision.revisionId,
      };
    } else {
      delete updatedConversation.activeTurn;
    }
    updatedConversation.revisions[commentNodeId] = revision;
    await this.#dependencies.conversationStateStore.write(state);
    return state;
  }
}
