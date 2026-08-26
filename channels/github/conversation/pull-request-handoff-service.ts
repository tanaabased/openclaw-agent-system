import { buildChannelInboundEventContext } from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationConversationId } from '../channel.ts';
import {
  githubNotificationPullRequestHandoffComment,
  githubNotificationPullRequestOpenedCard,
} from '../events/pull-request-opened.ts';
import type { GitHubNotificationAssignmentProviderAuthority } from '../intake/assignment-provider.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import resolveGitHubNotificationLifecycleEventSupport from '../lifecycles/event-support.ts';
import type { GitHubNotificationLifecycle } from '../lifecycles/types.ts';
import type { GitHubNotificationCommentClient } from '../provider/work-event-client.ts';
import { githubWorkItemKey } from '../provider/work-item.ts';
import type GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
import { githubNotificationChannelId, resolveNotificationRoute } from '../routing/routing.ts';
import { githubCommentRevision } from './comment-admission.ts';
import {
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversation,
  type GitHubNotificationConversationState,
  type GitHubNotificationDeliveryPullRequestState,
} from './conversation-state.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type { GitHubNotificationIssueDeliveryReceipt } from './issue-delivery-service.ts';
import type GitHubNotificationModelTurnCoordinator from './model-turn-coordinator.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';

export type GitHubNotificationPullRequestHandoffErrorCode =
  | 'github-notification-pull-request-handoff-baseline-failed'
  | 'github-notification-pull-request-handoff-event-failed'
  | 'github-notification-pull-request-handoff-publication-failed'
  | 'github-notification-pull-request-handoff-source-failed';

export class GitHubNotificationPullRequestHandoffError extends Error {
  override name = 'GitHubNotificationPullRequestHandoffError';

  constructor(
    readonly code: GitHubNotificationPullRequestHandoffErrorCode,
    options?: ErrorOptions,
  ) {
    super('The GitHub pull request handoff could not be reconciled.', options);
  }
}

export interface GitHubNotificationPullRequestHandoffServiceDependencies {
  assignmentAuthority: GitHubNotificationAssignmentProviderAuthority<GitHubNotificationCommentClient>;
  clock?: () => number;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  coordinator: Pick<GitHubNotificationModelTurnCoordinator, 'run'>;
  logger: Logger;
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'resolve'>;
}

interface GitHubNotificationPullRequestHandoffBaseInput {
  agentId: string;
  executionSurface: GitHubNotificationExecutionSurface;
  item: GitHubNotificationItemState;
  lifecycle: GitHubNotificationLifecycle;
  signal?: AbortSignal;
  workspaceDir: string;
}

export interface GitHubNotificationPullRequestHandoffCheckpointInput extends GitHubNotificationPullRequestHandoffBaseInput {
  pullRequest: GitHubNotificationIssueDeliveryReceipt;
}

export type GitHubNotificationPullRequestHandoffReconcileInput =
  GitHubNotificationPullRequestHandoffBaseInput;

interface HandoffConversationCheckpoint {
  conversation: GitHubNotificationConversation;
  source: GitHubNotificationDeliveryPullRequestState;
  state: GitHubNotificationConversationState;
}

function sortedComments<T extends { createdAt: string; databaseId: number }>(
  comments: readonly T[],
) {
  return [...comments].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.databaseId - right.databaseId,
  );
}

function nestedDiagnosticCode(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(error.code)
  ) {
    return error.code;
  }
  return undefined;
}

/** Link one delivered pull request to its issue-owned session and publish the handoff event. */
export default class GitHubNotificationPullRequestHandoffService {
  readonly #clock: () => number;
  readonly #dependencies: GitHubNotificationPullRequestHandoffServiceDependencies;

  constructor(dependencies: GitHubNotificationPullRequestHandoffServiceDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? Date.now;
  }

  async checkpoint(input: GitHubNotificationPullRequestHandoffCheckpointInput): Promise<void> {
    this.#validateInput(input);
    await this.#phase('github-notification-pull-request-handoff-source-failed', () =>
      this.#checkpointSource(input),
    );
  }

  async reconcile(input: GitHubNotificationPullRequestHandoffReconcileInput): Promise<void> {
    this.#validateInput(input);
    resolveGitHubNotificationLifecycleEventSupport(input.lifecycle, 'pull-request-opened');
    await this.#phase('github-notification-pull-request-handoff-baseline-failed', () =>
      this.#baselineSource(input),
    );
    await this.#phase('github-notification-pull-request-handoff-event-failed', () =>
      this.#recordEvent(input),
    );
    await this.#phase('github-notification-pull-request-handoff-publication-failed', () =>
      this.#publishHandoff(input),
    );
  }

  #validateInput(input: GitHubNotificationPullRequestHandoffBaseInput): void {
    if (
      input.item.itemType !== 'issue' ||
      input.item.lifecycleId !== 'issue' ||
      !input.item.intake
    ) {
      throw new GitHubNotificationPullRequestHandoffError(
        'github-notification-pull-request-handoff-source-failed',
      );
    }
  }

  #conversationId(input: GitHubNotificationPullRequestHandoffBaseInput): string {
    return githubNotificationConversationId({
      itemNumber: input.item.number,
      lifecycleId: input.item.lifecycleId,
      repositoryId: input.item.repositoryNodeId,
    });
  }

  async #conversation(
    input: GitHubNotificationPullRequestHandoffBaseInput,
  ): Promise<HandoffConversationCheckpoint> {
    const state = await this.#dependencies.conversationStateStore.read(input.agentId);
    const conversation = state?.conversations[this.#conversationId(input)];
    const source = conversation?.deliveryPullRequest;
    if (
      !state ||
      state.workspaceDir !== input.workspaceDir ||
      !conversation ||
      conversation.itemKey !== githubWorkItemKey(input.item.repositoryNodeId, input.item.number) ||
      conversation.lifecycleId !== input.item.lifecycleId ||
      conversation.implementation?.status !== 'completed' ||
      !source
    ) {
      throw new Error('The pull request handoff conversation checkpoint is missing.');
    }
    return { conversation, source, state };
  }

  async #checkpointSource(
    input: GitHubNotificationPullRequestHandoffCheckpointInput,
  ): Promise<void> {
    const conversationId = this.#conversationId(input);
    const current = await this.#dependencies.conversationStateStore.read(input.agentId);
    const conversation = current?.conversations[conversationId];
    if (
      !current ||
      current.workspaceDir !== input.workspaceDir ||
      !conversation ||
      conversation.itemKey !== githubWorkItemKey(input.item.repositoryNodeId, input.item.number) ||
      conversation.lifecycleId !== input.item.lifecycleId ||
      conversation.implementation?.status !== 'delivery-pending'
    ) {
      throw new Error('The pull request handoff source checkpoint is missing.');
    }
    const existing = conversation.deliveryPullRequest;
    if (
      existing &&
      (existing.nodeId !== input.pullRequest.pullRequestNodeId ||
        existing.number !== input.pullRequest.pullRequestNumber ||
        existing.status !== 'open')
    ) {
      throw new Error('The pull request handoff identity has changed.');
    }
    if (existing) return;
    const next = structuredClone(current);
    next.conversations[conversationId]!.deliveryPullRequest = {
      baselineEstablished: false,
      eventRecorded: false,
      nodeId: input.pullRequest.pullRequestNodeId,
      number: input.pullRequest.pullRequestNumber,
      status: 'open',
    };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #baselineSource(input: GitHubNotificationPullRequestHandoffReconcileInput): Promise<void> {
    const { source } = await this.#conversation(input);
    if (source.baselineEstablished) return;
    const opened = await this.#dependencies.assignmentAuthority.open({
      agentId: input.agentId,
      intake: input.item.intake!,
      item: input.item,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      workspaceDir: input.workspaceDir,
    });
    if (!opened.authorized) {
      throw new Error(
        `The pull request handoff is not currently authorized (${opened.reasonCode ?? 'github-notification-assignment-authority-revoked'}).`,
      );
    }
    const page = await opened.client.listIssueComments(
      input.item.repositoryOwner,
      input.item.repositoryName,
      source.number,
    );
    if (page.truncated) throw new Error('GitHub returned truncated pull request comments.');
    const observed = await this.#conversation(input);
    if (observed.source.nodeId !== source.nodeId || observed.source.status !== 'open') {
      throw new Error('The pull request handoff source checkpoint has changed.');
    }
    if (observed.source.baselineEstablished) return;
    const next = structuredClone(observed.state);
    const conversation = next.conversations[this.#conversationId(input)]!;
    for (const comment of sortedComments(page.comments)) {
      const revision = githubCommentRevision(comment);
      conversation.revisions[comment.nodeId] = {
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: comment.databaseId,
        reasonCode: 'comment-baseline',
        revisionId: revision.revisionId,
        source: { itemType: 'pull-request', number: source.number },
        status: 'baseline',
      };
    }
    conversation.deliveryPullRequest!.baselineEstablished = true;
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #recordEvent(input: GitHubNotificationPullRequestHandoffReconcileInput): Promise<void> {
    let checkpoint = await this.#conversation(input);
    if (checkpoint.source.eventRecorded) return;
    if (
      checkpoint.conversation.activeTurn &&
      (checkpoint.conversation.activeTurn.eventId !== 'pull-request-opened' ||
        checkpoint.conversation.activeTurn.sourceId !== checkpoint.source.nodeId)
    ) {
      throw new Error('Another GitHub notification model turn is active.');
    }
    if (!checkpoint.conversation.activeTurn) {
      const next = structuredClone(checkpoint.state);
      next.conversations[this.#conversationId(input)]!.activeTurn = {
        eventId: 'pull-request-opened',
        sourceId: checkpoint.source.nodeId,
      };
      await this.#dependencies.conversationStateStore.write(next);
      checkpoint = await this.#conversation(input);
    }

    const config = await this.#dependencies.readConfig();
    const route = resolveNotificationRoute(
      config,
      { agentId: input.agentId, enabled: true, workspaceDir: input.workspaceDir },
      this.#conversationId(input),
    );
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    const body = githubNotificationPullRequestOpenedCard({
      issueNumber: input.item.number,
      pullRequestNumber: checkpoint.source.number,
      repository,
    });
    const messageId = `pull-request-opened:${checkpoint.source.nodeId}`;
    const contract = this.#dependencies.turnContracts.resolve(
      {
        eventId: 'pull-request-opened',
        lifecycleId: input.item.lifecycleId,
        modeId: checkpoint.conversation.mode,
      },
      config,
      route.agentId,
    );
    const turn = await this.#dependencies.coordinator.run({
      config,
      contract,
      createIfMissing: false,
      ctxPayload: buildChannelInboundEventContext({
        accountId: route.accountId,
        channel: githubNotificationChannelId,
        channelContext: {
          chat: { id: route.conversationId },
          sender: { id: 'agent-system' },
        },
        conversation: {
          id: route.conversationId,
          kind: 'direct',
          label: `${repository}#${input.item.number}`,
          routePeer: { id: route.conversationId, kind: 'direct' },
        },
        from: 'agent-system:github-notifications',
        message: {
          body,
          bodyForAgent: body,
          commandBody: '',
          inboundEventKind: 'user_request',
          rawBody: body,
        },
        messageId,
        reply: { sourceReplyDeliveryMode: 'none', to: route.conversationId },
        route: {
          accountId: route.accountId,
          agentId: route.agentId,
          createIfMissing: false,
          routeSessionKey: route.sessionKey,
        },
        sender: {
          displayLabel: 'Agent System',
          id: 'agent-system',
          isBot: true,
          isSelf: false,
          name: 'Agent System',
          username: 'agent-system',
        },
        surface: githubNotificationChannelId,
        timestamp: this.#clock(),
      }),
      executionSurface: input.executionSurface,
      messageId,
      route,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      sourceId: checkpoint.source.nodeId,
    });
    if (turn.publication.status !== 'none') {
      throw new Error('The pull request opened event produced an unexpected publication intent.');
    }
    const observed = await this.#conversation(input);
    if (
      observed.source.nodeId !== checkpoint.source.nodeId ||
      observed.source.status !== 'open' ||
      observed.conversation.activeTurn?.eventId !== 'pull-request-opened' ||
      observed.conversation.activeTurn.sourceId !== checkpoint.source.nodeId
    ) {
      throw new Error('The pull request opened event checkpoint has changed.');
    }
    const next = structuredClone(observed.state);
    const conversation = next.conversations[this.#conversationId(input)]!;
    delete conversation.activeTurn;
    conversation.deliveryPullRequest!.eventRecorded = true;
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #publishHandoff(input: GitHubNotificationPullRequestHandoffReconcileInput): Promise<void> {
    let checkpoint = await this.#conversation(input);
    if (!checkpoint.source.baselineEstablished || !checkpoint.source.eventRecorded) {
      throw new Error('The pull request handoff publication prerequisites are missing.');
    }
    if (checkpoint.source.handoff?.status === 'published') return;
    if (!checkpoint.source.handoff) {
      const publicText = githubNotificationPullRequestHandoffComment(checkpoint.source.number);
      const next = structuredClone(checkpoint.state);
      next.conversations[this.#conversationId(input)]!.deliveryPullRequest!.handoff = {
        publicText,
        publicTextDigest: githubNotificationPublicTextDigest(publicText),
        status: 'pending',
        target: githubNotificationPublicationTarget({
          conversationId: this.#conversationId(input),
          intent: 'pull-request-handoff',
          publicationId: checkpoint.source.nodeId,
        }),
      };
      await this.#dependencies.conversationStateStore.write(next);
      checkpoint = await this.#conversation(input);
    }
    if (checkpoint.source.handoff?.status !== 'pending') {
      throw new Error('The pull request handoff publication checkpoint is missing.');
    }
    const result = await this.#dependencies.publications.publish({
      accountId: input.agentId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      target: checkpoint.source.handoff.target,
      text: checkpoint.source.handoff.publicText,
    });
    const observed = await this.#conversation(input);
    const handoff = observed.source.handoff;
    if (handoff?.status !== 'pending' || handoff.target !== result.target) {
      throw new Error('The pull request handoff publication checkpoint has changed.');
    }
    const next = structuredClone(observed.state);
    next.conversations[this.#conversationId(input)]!.deliveryPullRequest!.handoff = {
      ...handoff,
      commentDatabaseId: result.receipt.databaseId,
      commentNodeId: result.receipt.nodeId,
      status: 'published',
    };
    await this.#dependencies.conversationStateStore.write(next);
    this.#dependencies.logger.info(
      `github-notifications: pull request handoff completed agent=${input.agentId} issue=${input.item.number} pr=${observed.source.number}`,
    );
  }

  async #phase(
    code: GitHubNotificationPullRequestHandoffErrorCode,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (error instanceof GitHubNotificationPullRequestHandoffError) throw error;
      const causeCode = nestedDiagnosticCode(error);
      this.#dependencies.logger.warn(
        `github-notifications: pull request handoff failed phase=${code.replace('github-notification-pull-request-handoff-', '').replace('-failed', '')} code=${code}${causeCode ? ` causeCode=${causeCode}` : ''}`,
      );
      throw new GitHubNotificationPullRequestHandoffError(code, { cause: error });
    }
  }
}
