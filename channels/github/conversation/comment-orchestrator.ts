import {
  admitReviewFeedback,
  isReviewFeedback,
  readReviewFeedback,
  reviewFeedback,
  reviewReplyFeedback,
  reviewFeedbackRevision,
  type GitHubCanonicalFeedback,
  type GitHubReviewFeedback,
} from './review-feedback.ts';
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
  createGitHubNotificationConversationSnapshot,
  githubNotificationPublicTextDigest,
  type GitHubNotificationCommentRevisionState,
  type GitHubNotificationConversationSource,
  type GitHubNotificationConversationSnapshot,
} from './conversation-state.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type {
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../intake/monitor/state.ts';
import { patchGitHubNotificationItem } from '../intake/monitor/state-checkpoint.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
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
import { defaultMaximumCommentCharacters } from '../provider/comment-limit.ts';

type GitHubNotificationConversationClient = GitHubNotificationCommentClient &
  Pick<GitHubNotificationIntakeClient, 'getItem'>;

const maximumCommentResponsesPerReconciliation = 2;

export interface GitHubNotificationCommentOrchestratorDependencies {
  assignmentAuthority: GitHubNotificationAssignmentProviderAuthority<GitHubNotificationConversationClient>;
  clock?: () => number;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  initialModeId:
    | GitHubNotificationModeId
    | ((input: {
        agentId: string;
        workspaceDir: string;
      }) => GitHubNotificationModeId | Promise<GitHubNotificationModeId>);
  lifecycles: Pick<GitHubNotificationLifecycleRegistry, 'resolve'>;
  logger: Logger;
  monitorStateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'update'>;
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

function publicationReceipt(receipt: { databaseId: number; nodeId: string }): {
  databaseId: number;
  nodeId: string;
} {
  if (
    !Number.isSafeInteger(receipt.databaseId) ||
    receipt.databaseId < 1 ||
    typeof receipt.nodeId !== 'string' ||
    !receipt.nodeId.trim()
  ) {
    throw new GitHubNotificationCommentOrchestratorError(
      'github-notification-publication-receipt-invalid',
    );
  }
  return { databaseId: receipt.databaseId, nodeId: receipt.nodeId };
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
  readonly #dependencies: GitHubNotificationCommentOrchestratorDependencies;

  constructor(dependencies: GitHubNotificationCommentOrchestratorDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? Date.now;
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
      (await this.#dependencies.conversationStateStore.read(agentId, conversationId)) ??
      createGitHubNotificationConversationSnapshot(agentId, monitor.workspaceDir, conversationId);
    if (state.workspaceDir !== monitor.workspaceDir) {
      throw new GitHubNotificationCommentOrchestratorError(
        'github-notification-conversation-workspace-mismatch',
      );
    }
    const existingConversation = state.conversation;
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
    const configuredInitialModeId = this.#dependencies.initialModeId;
    const modeId =
      existingConversation?.mode ??
      (typeof configuredInitialModeId === 'function'
        ? await configuredInitialModeId({ agentId, workspaceDir: monitor.workspaceDir })
        : configuredInitialModeId);
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
        monitor,
      ))
    ) {
      return;
    }
    // handoff owns the initial baseline and active event, including interrupted retries.
    // provider close/merge transitions above still take precedence over pending delivery.
    const delivery = existingConversation?.deliveryPullRequest;
    if (
      delivery?.status === 'open' &&
      (!delivery.eventRecorded ||
        (existingConversation?.implementation?.status === 'completed' &&
          delivery.baselineEstablished &&
          delivery.handoff?.status !== 'published'))
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
    if (
      Object.values(existingConversation?.revisions ?? {}).some(
        (revision) => revision.review && revision.status === 'admitted',
      )
    ) {
      await this.#reconcileReviews(
        agentId,
        conversationId,
        item,
        sources,
        opened,
        modeId,
        monitor.workspaceDir,
        options,
        maximumCommentResponsesPerReconciliation,
      );
      return;
    }
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
      state.conversation = {
        ...(existingConversation ?? {}),
        baselineEstablished: existingConversation?.baselineEstablished ?? false,
        itemKey,
        lifecycleId: item.lifecycleId,
        mode: modeId,
        revisions: { ...(existingConversation?.revisions ?? {}) },
      };
      const conversation = state.conversation!;
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
    let responseCount = 0;
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
        maximumCommentCharacters: opened.client.maximumCommentCharacters,
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
        if (admission.code === 'comment-body-truncated') {
          this.#dependencies.logger.warn(
            `github-notifications: comment rejected agent=${agentId} item=${item.repositoryOwner}/${item.repositoryName}#${source.number} code=${admission.code} maxCommentCharacters=${opened.client.maximumCommentCharacters ?? defaultMaximumCommentCharacters}`,
          );
        }
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
      responseCount += 1;
      if (responseCount >= maximumCommentResponsesPerReconciliation) return;
    }
    await this.#reconcileReviews(
      agentId,
      conversationId,
      item,
      sources,
      opened,
      modeId,
      monitor.workspaceDir,
      options,
      maximumCommentResponsesPerReconciliation - responseCount,
    );
  }

  async #reconcileReviews(
    agentId: string,
    conversationId: string,
    item: GitHubNotificationItemState,
    sources: GitHubNotificationCommentSource[],
    opened: Extract<
      Awaited<
        ReturnType<GitHubNotificationCommentOrchestratorDependencies['assignmentAuthority']['open']>
      >,
      { authorized: true }
    >,
    modeId: GitHubNotificationModeId,
    workspaceDir: string,
    options: GitHubNotificationCommentReconcileOptions,
    budget: number,
  ): Promise<void> {
    const client = opened.client.reviews;
    if (!client) return;
    const owner = item.repositoryOwner;
    const name = item.repositoryName;
    for (const source of sources.filter((value) => value.itemType === 'pull-request')) {
      const initial = await this.#dependencies.conversationStateStore.read(agentId, conversationId);
      const cursor = initial?.conversation?.reviewIntake?.[source.number] ?? {
        reviewsPage: 1,
        commentsPage: 1,
      };
      const consume = async (feedback: GitHubReviewFeedback) => {
        if (feedback.feedback.review.state === 'PENDING' || !feedback.feedback.review.submittedAt)
          return;
        const snapshot = await this.#dependencies.conversationStateStore.read(
          agentId,
          conversationId,
        );
        const previous = snapshot?.conversation?.revisions[feedback.nodeId];
        const revision = reviewFeedbackRevision(feedback);
        if (previous?.revisionId === revision.revisionId && previous.status !== 'admitted') {
          if (
            cursor.baselineBefore !== undefined &&
            previous.reviewBaselineAt !== cursor.baselineBefore
          )
            await this.#checkpointRevision(agentId, conversationId, feedback.nodeId, {
              ...previous,
              reviewBaselineAt: cursor.baselineBefore,
            });
          return;
        }
        if (
          previous?.status === 'admitted' &&
          previous.revisionId === revision.revisionId &&
          previous.review
        )
          feedback.feedback.receipt = previous.review;
        const exact = await readReviewFeedback(
          client,
          owner,
          name,
          source.number,
          feedback.databaseId,
          feedback.feedback.receipt,
        );
        if (
          exact.nodeId !== feedback.nodeId ||
          reviewFeedbackRevision(exact).revisionId !== revision.revisionId
        )
          throw new GitHubNotificationCommentOrchestratorError(
            'github-notification-comment-revision-changed',
          );
        const admission = admitReviewFeedback({
          account: opened.client.identity,
          comment: exact,
          configuration: opened.configuration,
          maximumCommentCharacters: opened.client.maximumCommentCharacters,
        });
        const unchanged =
          !exact.feedback.receipt.summarySelected && exact.feedback.receipt.selected.length === 0;
        const baseline =
          unchanged ||
          (previous?.reviewBaselineAt !== cursor.baselineBefore &&
            cursor.baselineBefore !== undefined &&
            Date.parse(exact.createdAt) <= cursor.baselineBefore);
        const checkpoint: GitHubNotificationCommentRevisionState = {
          ...revision,
          commentDatabaseId: exact.databaseId,
          review: exact.feedback.receipt,
          ...(cursor.baselineBefore !== undefined
            ? { reviewBaselineAt: cursor.baselineBefore }
            : {}),
          source: { itemType: source.itemType, number: source.number },
          status: baseline
            ? 'baseline'
            : admission.disposition === 'approved'
              ? 'admitted'
              : 'rejected',
          reasonCode: baseline ? 'comment-baseline' : admission.code,
        };
        await this.#checkpointRevision(agentId, conversationId, exact.nodeId, checkpoint);
        if (baseline || admission.disposition !== 'approved') return;
        await this.#respond(
          agentId,
          conversationId,
          options.executionSurface,
          exact,
          [],
          revision,
          item,
          modeId,
          checkpoint.source,
          workspaceDir,
          options.signal,
        );
        budget--;
      };
      const interrupted = Object.values(initial?.conversation?.revisions ?? {}).find(
        (revision) =>
          revision.status === 'admitted' &&
          revision.review &&
          revision.source.number === source.number,
      );
      if (interrupted?.review) {
        const exact = await readReviewFeedback(
          client,
          owner,
          name,
          source.number,
          interrupted.commentDatabaseId,
          interrupted.review,
        );
        await consume(
          exact.feedback.receipt.kind === 'review'
            ? reviewFeedback(
                exact.feedback.review,
                exact.feedback.comments,
                interrupted.consumedReview,
              )
            : exact,
        );
        if (budget <= 0) return;
      }
      const reviews = await client.listReviews(owner, name, source.number, cursor.reviewsPage);
      for (const review of reviews.values) {
        if (review.state === 'PENDING' || !review.submittedAt) continue;
        const snapshot = await this.#dependencies.conversationStateStore.read(
          agentId,
          conversationId,
        );
        const previous = snapshot?.conversation?.revisions[review.nodeId];
        const consumed =
          previous?.consumedReview ??
          (previous?.status === 'responded' || previous?.status === 'baseline'
            ? previous.review
            : undefined);
        await consume(
          reviewFeedback(
            review,
            await client.getReviewComments(owner, name, source.number, review.databaseId),
            consumed,
          ),
        );
        if (budget <= 0) return;
      }
      await this.#checkpointReviewCursor(agentId, conversationId, source.number, {
        ...cursor,
        reviewsPage: reviews.nextPage,
      });
      const replies = await client.listComments(owner, name, source.number, cursor.commentsPage);
      for (const reply of replies.values) {
        if (!reply.replyToId) continue;
        const review = await client.getReview(owner, name, source.number, reply.reviewId);
        const snapshot = await this.#dependencies.conversationStateStore.read(
          agentId,
          conversationId,
        );
        const group = snapshot?.conversation?.revisions[review.nodeId]?.review;
        if (
          group?.members[reply.nodeId] ||
          (!group &&
            Date.parse(reply.createdAt) <= Date.parse(review.submittedAt ?? '') &&
            reply.author?.nodeId === review.author?.nodeId)
        )
          continue;
        await consume(reviewReplyFeedback(review, reply));
        if (budget <= 0) return;
      }
      await this.#checkpointReviewCursor(agentId, conversationId, source.number, {
        ...cursor,
        reviewsPage: reviews.nextPage,
        commentsPage: replies.nextPage,
      });
    }
  }

  async #checkpointReviewCursor(
    agentId: string,
    conversationId: string,
    number: number,
    cursor: { reviewsPage: number; commentsPage: number; baselineBefore?: number },
  ): Promise<void> {
    const current = await this.#dependencies.conversationStateStore.read(agentId, conversationId);
    if (!current?.conversation)
      throw new GitHubNotificationCommentOrchestratorError(
        'github-notification-conversation-state-missing',
      );
    const previous = current.conversation.reviewIntake?.[number] ?? {
      reviewsPage: 1,
      commentsPage: 1,
    };
    if (
      previous.reviewsPage === cursor.reviewsPage &&
      previous.commentsPage === cursor.commentsPage &&
      previous.baselineBefore === cursor.baselineBefore
    )
      return;
    const next = structuredClone(current);
    next.conversation!.reviewIntake = { ...next.conversation!.reviewIntake, [number]: cursor };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #reconcileDeliveryPullRequest(
    agentId: string,
    conversationId: string,
    itemKey: string,
    item: GitHubNotificationItemState,
    client: GitHubNotificationConversationClient,
    expectedMonitor: GitHubNotificationMonitorState,
  ): Promise<boolean> {
    const current = await this.#dependencies.conversationStateStore.read(agentId, conversationId);
    const conversation = current?.conversation;
    if (!current || !conversation) return false;
    const next = structuredClone(current);
    const updated = next.conversation!;
    const source = conversation.deliveryPullRequest;
    if (!source || source.status === 'merged') return false;
    const observed = await client.getItem(item.repositoryOwner, item.repositoryName, source.number);
    if (
      observed.itemType !== 'pull-request' ||
      observed.nodeId !== source.nodeId ||
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
    if (status === 'open' && source.status === 'closed') {
      updated.reviewIntake = {
        ...updated.reviewIntake,
        [source.number]: { reviewsPage: 1, commentsPage: 1, baselineBefore: this.#clock() },
      };
    }
    if (status !== 'open' || source.status === 'closed') {
      updatedSource.baselineEstablished = false;
    }
    const merged = status === 'merged';
    if (merged) {
      const verifiedAt = this.#clock();
      await this.#dependencies.monitorStateStore.update(agentId, (monitor) =>
        patchGitHubNotificationItem(monitor, expectedMonitor, itemKey, {
          disposition: 'retired',
          intake: { providerRetirementVerifiedAt: verifiedAt, stage: 'retired' },
          reasonCode: 'pull-request-merged',
        }),
      );
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
    comment: GitHubCanonicalFeedback,
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
        ...(isReviewFeedback(comment) ? { review: comment.feedback.receipt } : {}),
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
        ...(isReviewFeedback(comment) ? { review: comment.feedback.receipt } : {}),
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
      ...(isReviewFeedback(comment) ? { review: comment.feedback.receipt } : {}),
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
    const delivered = await this.#dependencies.publications.publish({
      accountId: response.agentId,
      ...(signal === undefined ? {} : { signal }),
      target,
      text: response.publication.publicText,
    });
    const receipt = publicationReceipt(delivered.receipt);
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
    let result;
    try {
      result = await this.#dependencies.publications.publish({
        accountId: agentId,
        ...(signal === undefined ? {} : { signal }),
        target: publication.target,
        text: publication.publicText,
      });
    } catch (error) {
      if (
        !revision.review ||
        !(error instanceof Error) ||
        !('code' in error) ||
        ![
          'github-notification-publication-source-changed',
          'comment-actor-unapproved',
          'comment-mention-missing',
          'comment-mention-quote-only',
          'comment-review-pending',
          'github-notification-resource-missing',
        ].includes(String(error.code))
      )
        throw error;
      await this.#checkpointRevision(agentId, conversationId, commentNodeId, {
        ...revision,
        publication: { status: 'withheld', reasonCode: String(error.code) },
      });
      return;
    }
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
    const current = await this.#dependencies.conversationStateStore.read(agentId, conversationId);
    const revision = current?.conversation?.revisions[commentNodeId];
    if (
      !current ||
      revision?.revisionId !== revisionId ||
      !revision.publication ||
      revision.publication.status !== 'pending'
    ) {
      return;
    }
    const state = structuredClone(current);
    state.conversation!.revisions[commentNodeId] = {
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
  ): Promise<GitHubNotificationConversationSnapshot> {
    const current = await this.#dependencies.conversationStateStore.read(agentId, conversationId);
    const conversation = current?.conversation;
    if (!current || !conversation) {
      throw new GitHubNotificationCommentOrchestratorError(
        'github-notification-conversation-state-missing',
      );
    }
    const state = structuredClone(current);
    const updatedConversation = state.conversation!;
    if (revision.status === 'admitted') {
      updatedConversation.activeTurn = {
        eventId: 'comment',
        sourceId: revision.revisionId,
      };
    } else {
      delete updatedConversation.activeTurn;
    }
    const previous = updatedConversation.revisions[commentNodeId];
    if (previous?.reviewBaselineAt !== undefined && revision.reviewBaselineAt === undefined)
      revision = { ...revision, reviewBaselineAt: previous.reviewBaselineAt };
    if (revision.review) {
      const consumed =
        revision.status === 'responded' || revision.status === 'baseline'
          ? revision.review
          : (previous?.consumedReview ??
            (previous?.status === 'responded' || previous?.status === 'baseline'
              ? previous.review
              : undefined));
      if (consumed) revision = { ...revision, consumedReview: consumed };
    }
    if (
      !Object.hasOwn(updatedConversation.revisions, commentNodeId) &&
      Object.keys(updatedConversation.revisions).length >= 400
    )
      throw new GitHubNotificationCommentOrchestratorError(
        'github-notification-feedback-capacity-exceeded',
      );
    updatedConversation.revisions[commentNodeId] = revision;
    await this.#dependencies.conversationStateStore.write(state);
    return state;
  }
}
