import {
  buildChannelInboundEventContext,
  runPreparedInboundReply,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationConversationId } from '../channel.ts';
import {
  githubNotificationPullRequestHandoffComment,
  githubNotificationPullRequestOpenedCard,
} from '../events/pull-request-opened.ts';
import type GitHubNotificationEventRegistry from '../events/registry.ts';
import type { GitHubNotificationAssignmentProviderAuthority } from '../intake/assignment-provider.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import resolveGitHubNotificationLifecycleEventSupport from '../lifecycles/event-support.ts';
import type { GitHubNotificationLifecycle } from '../lifecycles/types.ts';
import type { GitHubNotificationCommentClient } from '../provider/work-event-client.ts';
import type GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
import { githubNotificationChannelId, resolveNotificationRoute } from '../routing/routing.ts';
import { githubCommentRevision } from './comment-admission.ts';
import {
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversationState,
  type GitHubNotificationDeliveryPullRequestState,
} from './conversation-state.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type { GitHubNotificationIssueDeliveryReceipt } from './issue-delivery-service.ts';

export interface GitHubNotificationPullRequestHandoffServiceDependencies {
  assignmentAuthority: GitHubNotificationAssignmentProviderAuthority<GitHubNotificationCommentClient>;
  clock?: () => number;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  events: Pick<GitHubNotificationEventRegistry, 'resolve'>;
  logger: Logger;
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
  runPreparedReply?: (input: PreparedInboundReply<void>) => Promise<unknown>;
}

export interface GitHubNotificationPullRequestHandoffInput {
  agentId: string;
  item: GitHubNotificationItemState;
  lifecycle: GitHubNotificationLifecycle;
  pullRequest: GitHubNotificationIssueDeliveryReceipt;
  signal?: AbortSignal;
  workspaceDir: string;
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

function deliveryPullRequest(
  state: GitHubNotificationConversationState | undefined,
  conversationId: string,
  nodeId: string,
): GitHubNotificationDeliveryPullRequestState | undefined {
  const pullRequest = state?.conversations[conversationId]?.deliveryPullRequest;
  return pullRequest?.nodeId === nodeId ? pullRequest : undefined;
}

/** Link one delivered pull request to its issue-owned session and publish the handoff event. */
export default class GitHubNotificationPullRequestHandoffService {
  readonly #clock: () => number;
  readonly #dependencies: GitHubNotificationPullRequestHandoffServiceDependencies;
  readonly #runPreparedReply: (input: PreparedInboundReply<void>) => Promise<unknown>;

  constructor(dependencies: GitHubNotificationPullRequestHandoffServiceDependencies) {
    this.#dependencies = dependencies;
    this.#clock = dependencies.clock ?? Date.now;
    this.#runPreparedReply = dependencies.runPreparedReply ?? runPreparedInboundReply;
  }

  async link(input: GitHubNotificationPullRequestHandoffInput): Promise<void> {
    if (
      input.item.itemType !== 'issue' ||
      input.item.lifecycleId !== 'issue' ||
      !input.item.intake
    ) {
      throw new Error('Pull request handoff requires one prepared issue conversation.');
    }
    const event = this.#dependencies.events.resolve('pull-request-opened');
    if (event.turn.kind !== 'observe-only') {
      throw new Error('The pull request opened event must remain observe-only.');
    }
    resolveGitHubNotificationLifecycleEventSupport(input.lifecycle, event.id);
    const conversationId = githubNotificationConversationId({
      itemNumber: input.item.number,
      lifecycleId: input.item.lifecycleId,
      repositoryId: input.item.repositoryNodeId,
    });
    await this.#checkpointSource(input, conversationId);
    await this.#baselineSource(input, conversationId);
    await this.#recordEvent(input, conversationId);
    await this.#publishHandoff(input, conversationId);
  }

  async #checkpointSource(
    input: GitHubNotificationPullRequestHandoffInput,
    conversationId: string,
  ): Promise<void> {
    const current = await this.#dependencies.conversationStateStore.read(input.agentId);
    const conversation = current?.conversations[conversationId];
    if (
      !current ||
      current.workspaceDir !== input.workspaceDir ||
      !conversation ||
      conversation.implementation?.status !== 'delivery-pending'
    ) {
      throw new Error('The pull request handoff conversation checkpoint is missing.');
    }
    const existing = conversation.deliveryPullRequest;
    if (
      existing &&
      (existing.nodeId !== input.pullRequest.pullRequestNodeId ||
        existing.itemDatabaseId !== input.pullRequest.pullRequestDatabaseId ||
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
      itemDatabaseId: input.pullRequest.pullRequestDatabaseId,
      nodeId: input.pullRequest.pullRequestNodeId,
      number: input.pullRequest.pullRequestNumber,
      status: 'open',
    };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #baselineSource(
    input: GitHubNotificationPullRequestHandoffInput,
    conversationId: string,
  ): Promise<void> {
    const current = await this.#dependencies.conversationStateStore.read(input.agentId);
    if (
      deliveryPullRequest(current, conversationId, input.pullRequest.pullRequestNodeId)
        ?.baselineEstablished
    ) {
      return;
    }
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
      input.pullRequest.pullRequestNumber,
    );
    if (page.truncated) throw new Error('GitHub returned truncated pull request comments.');
    const observed = await this.#dependencies.conversationStateStore.read(input.agentId);
    const source = deliveryPullRequest(
      observed,
      conversationId,
      input.pullRequest.pullRequestNodeId,
    );
    if (!observed || !source || source.status !== 'open') {
      throw new Error('The pull request handoff source checkpoint has changed.');
    }
    if (source.baselineEstablished) return;
    const next = structuredClone(observed);
    const conversation = next.conversations[conversationId]!;
    for (const comment of sortedComments(page.comments)) {
      const revision = githubCommentRevision(comment);
      conversation.revisions[comment.nodeId] = {
        bodyDigest: revision.bodyDigest,
        commentDatabaseId: comment.databaseId,
        reasonCode: 'comment-baseline',
        revisionId: revision.revisionId,
        source: { itemType: 'pull-request', number: input.pullRequest.pullRequestNumber },
        status: 'baseline',
      };
    }
    conversation.deliveryPullRequest!.baselineEstablished = true;
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #recordEvent(
    input: GitHubNotificationPullRequestHandoffInput,
    conversationId: string,
  ): Promise<void> {
    const current = await this.#dependencies.conversationStateStore.read(input.agentId);
    if (
      deliveryPullRequest(current, conversationId, input.pullRequest.pullRequestNodeId)
        ?.eventRecorded
    ) {
      return;
    }
    const config = await this.#dependencies.readConfig();
    const route = resolveNotificationRoute(
      config,
      { agentId: input.agentId, enabled: true, workspaceDir: input.workspaceDir },
      conversationId,
    );
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    const body = githubNotificationPullRequestOpenedCard({
      issueNumber: input.item.number,
      pullRequestNumber: input.pullRequest.pullRequestNumber,
      repository,
    });
    const messageId = `pull-request-opened:${input.pullRequest.pullRequestNodeId}`;
    const ctxPayload = buildChannelInboundEventContext({
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
    });
    let sessionRecordTask: Promise<unknown> | undefined;
    await this.#runPreparedReply({
      accountId: route.accountId,
      admission: { kind: 'observeOnly', reason: 'pull-request-opened' },
      afterRecord: async () => {
        if (!sessionRecordTask || !(await sessionRecordTask)) {
          throw new Error('The pull request opened event session is missing.');
        }
      },
      channel: githubNotificationChannelId,
      ctxPayload,
      messageId,
      observeOnlyDispatchResult: undefined,
      record: {
        createIfMissing: false,
        onRecordError(error) {
          throw new Error('The pull request opened event could not be recorded.', { cause: error });
        },
        trackSessionMetaTask(task) {
          sessionRecordTask = task;
        },
      },
      recordInboundSession: this.#dependencies.recordInboundSession,
      routeSessionKey: route.sessionKey,
      runDispatch: async () => undefined,
      storePath: resolveStorePath(config.session?.store, { agentId: route.agentId }),
    });
    const observed = await this.#dependencies.conversationStateStore.read(input.agentId);
    const source = deliveryPullRequest(
      observed,
      conversationId,
      input.pullRequest.pullRequestNodeId,
    );
    if (!observed || !source || source.status !== 'open') {
      throw new Error('The pull request opened event checkpoint has changed.');
    }
    if (source.eventRecorded) return;
    const next = structuredClone(observed);
    next.conversations[conversationId]!.deliveryPullRequest!.eventRecorded = true;
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #publishHandoff(
    input: GitHubNotificationPullRequestHandoffInput,
    conversationId: string,
  ): Promise<void> {
    let current = await this.#dependencies.conversationStateStore.read(input.agentId);
    let source = deliveryPullRequest(current, conversationId, input.pullRequest.pullRequestNodeId);
    if (!current || !source || !source.baselineEstablished || !source.eventRecorded) {
      throw new Error('The pull request handoff publication prerequisites are missing.');
    }
    if (source.handoff?.status === 'published') return;
    if (!source.handoff) {
      const publicText = githubNotificationPullRequestHandoffComment(
        input.pullRequest.pullRequestNumber,
      );
      const next = structuredClone(current);
      next.conversations[conversationId]!.deliveryPullRequest!.handoff = {
        publicText,
        publicTextDigest: githubNotificationPublicTextDigest(publicText),
        status: 'pending',
        target: githubNotificationPublicationTarget({
          conversationId,
          intent: 'pull-request-handoff',
          publicationId: input.pullRequest.pullRequestNodeId,
        }),
      };
      await this.#dependencies.conversationStateStore.write(next);
      current = next;
      source = deliveryPullRequest(current, conversationId, input.pullRequest.pullRequestNodeId);
    }
    if (source?.handoff?.status !== 'pending') {
      throw new Error('The pull request handoff publication checkpoint is missing.');
    }
    const result = await this.#dependencies.publications.publish({
      accountId: input.agentId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      target: source.handoff.target,
      text: source.handoff.publicText,
    });
    const observed = await this.#dependencies.conversationStateStore.read(input.agentId);
    const handoff = deliveryPullRequest(
      observed,
      conversationId,
      input.pullRequest.pullRequestNodeId,
    )?.handoff;
    if (!observed || handoff?.status !== 'pending' || handoff.target !== result.target) {
      throw new Error('The pull request handoff publication checkpoint has changed.');
    }
    const next = structuredClone(observed);
    next.conversations[conversationId]!.deliveryPullRequest!.handoff = {
      ...handoff,
      commentDatabaseId: result.receipt.databaseId,
      commentNodeId: result.receipt.nodeId,
      status: 'published',
    };
    await this.#dependencies.conversationStateStore.write(next);
    this.#dependencies.logger.info(
      `github-notifications: pull request handoff completed agent=${input.agentId} issue=${input.item.number} pr=${input.pullRequest.pullRequestNumber}`,
    );
  }
}
