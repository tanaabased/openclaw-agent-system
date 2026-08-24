import { buildChannelInboundEventContext } from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationAssignmentCard } from '../events/assignment.ts';
import { githubNotificationImplementationCard } from '../events/implementation.ts';
import githubNotificationAssignmentContext from './context/assignment.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import type {
  GitHubNotificationLifecycle,
  GitHubNotificationLifecycleWorktree,
} from '../lifecycles/types.ts';
import resolveGitHubNotificationLifecycleEventSupport from '../lifecycles/event-support.ts';
import resolveGitHubNotificationLifecycleModeSupport from '../lifecycles/mode-support.ts';
import type { GitHubNotificationMode } from '../modes/types.ts';
import { githubNotificationConversationId } from '../channel.ts';
import {
  githubNotificationChannelId,
  resolveNotificationRoute,
  type ResolvedNotificationRoute,
} from '../routing/routing.ts';
import { githubWorkItemKey } from '../provider/work-item.ts';
import type GitHubNotificationCommentPublicationService from '../publication/comment-publication-service.ts';
import { githubNotificationPublicationTarget } from '../publication/publication.ts';
import type GitHubNotificationAssignmentAcknowledgmentService from './assignment-acknowledgment-service.ts';
import {
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversation,
  type GitHubNotificationConversationState,
  type GitHubNotificationPublicationState,
} from './conversation-state.ts';
import type GitHubNotificationConversationStateStore from './conversation-state-store.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type GitHubNotificationModelTurnCoordinator from './model-turn-coordinator.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';
import type GitHubNotificationIssueDeliveryService from './issue-delivery-service.ts';

export interface GitHubNotificationAssignmentSessionServiceDependencies {
  acknowledgments: Pick<GitHubNotificationAssignmentAcknowledgmentService, 'publish'>;
  conversationStateStore: Pick<GitHubNotificationConversationStateStore, 'read' | 'write'>;
  coordinator: Pick<GitHubNotificationModelTurnCoordinator, 'run'>;
  deliveries: Pick<GitHubNotificationIssueDeliveryService, 'deliver'>;
  logger: Logger;
  publications: Pick<GitHubNotificationCommentPublicationService, 'publish'>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'resolve'>;
}

export interface GitHubNotificationAssignmentSessionInput {
  agentId: string;
  executionSurface: GitHubNotificationExecutionSurface;
  item: GitHubNotificationItemState;
  lifecycle: GitHubNotificationLifecycle;
  mode: Pick<GitHubNotificationMode, 'policy'>;
  signal?: AbortSignal;
  workspaceDir: string;
  worktree?: GitHubNotificationLifecycleWorktree;
}

interface AssignmentConversationCheckpoint {
  conversation: GitHubNotificationConversation;
  state: GitHubNotificationConversationState;
}

interface ModelTurnContextInput {
  body: string;
  lifecycleContext: Readonly<Record<string, unknown>>;
  messageId: string;
  repository: string;
  route: ResolvedNotificationRoute;
  sender: {
    from: string;
    id: string;
    isBot: boolean;
    isSelf: boolean;
    label: string;
  };
  timestamp: number;
}

interface AssignmentImplementationInput {
  assignmentEventId: string;
  config: OpenClawConfig;
  conversationId: string;
  lifecycleContext: Readonly<Record<string, unknown>>;
  projectionTimestamp: number;
  repository: string;
  route: ResolvedNotificationRoute;
  session: GitHubNotificationAssignmentSessionInput;
}

function modelTurnContext(input: ModelTurnContextInput) {
  return buildChannelInboundEventContext({
    accountId: input.route.accountId,
    channel: githubNotificationChannelId,
    channelContext: {
      chat: { id: input.route.conversationId },
      sender: { id: input.sender.id },
    },
    conversation: {
      id: input.route.conversationId,
      kind: 'direct',
      label: input.repository,
      routePeer: { id: input.route.conversationId, kind: 'direct' },
    },
    extra: {
      UntrustedStructuredContext: [
        githubNotificationAssignmentContext({ lifecycleContext: input.lifecycleContext }),
      ],
    },
    from: input.sender.from,
    message: {
      body: input.body,
      bodyForAgent: input.body,
      commandBody: '',
      inboundEventKind: 'user_request',
      rawBody: input.body,
    },
    messageId: input.messageId,
    reply: { sourceReplyDeliveryMode: 'none', to: input.route.conversationId },
    route: {
      accountId: input.route.accountId,
      agentId: input.route.agentId,
      createIfMissing: true,
      routeSessionKey: input.route.sessionKey,
    },
    sender: {
      displayLabel: input.sender.label,
      id: input.sender.id,
      isBot: input.sender.isBot,
      isSelf: input.sender.isSelf,
      name: input.sender.label,
      username: input.sender.label,
    },
    surface: githubNotificationChannelId,
    timestamp: input.timestamp,
  });
}

/** Prepare and run one lifecycle assignment through the shared model-turn boundary. */
export default class GitHubNotificationAssignmentSessionService {
  readonly #dependencies: GitHubNotificationAssignmentSessionServiceDependencies;

  constructor(dependencies: GitHubNotificationAssignmentSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(input: GitHubNotificationAssignmentSessionInput): Promise<void> {
    const assignmentSupport = resolveGitHubNotificationLifecycleEventSupport(
      input.lifecycle,
      'assignment',
    );
    resolveGitHubNotificationLifecycleModeSupport(input.lifecycle, input.mode.policy.id);
    if (!assignmentSupport.session) {
      throw new Error('The GitHub lifecycle does not support assignment sessions.');
    }
    const projection = assignmentSupport.session.project(input.item);
    const lifecycleContext = input.lifecycle.context.project({
      item: input.item,
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    });
    const config = await this.#dependencies.readConfig();
    const conversationId = githubNotificationConversationId({
      itemNumber: input.item.number,
      lifecycleId: input.item.lifecycleId,
      repositoryId: input.item.repositoryNodeId,
    });
    const route = resolveNotificationRoute(
      config,
      { agentId: input.agentId, enabled: true, workspaceDir: input.workspaceDir },
      conversationId,
    );
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    const body = githubNotificationAssignmentCard(projection, input.mode.policy.id);
    const assignmentEventId = input.item.intake?.assignmentEventId;
    if (!assignmentEventId || assignmentEventId !== input.item.assignmentEventNodeId) {
      throw new Error('The GitHub assignment turn is missing its intake identity.');
    }
    const messageId = `assignment:${assignmentEventId}`;
    const ctxPayload = modelTurnContext({
      body,
      lifecycleContext,
      messageId,
      repository: `${repository}#${input.item.number}`,
      route,
      sender: {
        from: `github:${projection.sender.id}`,
        id: projection.sender.id,
        isBot: false,
        isSelf: false,
        label: projection.sender.label,
      },
      timestamp: projection.timestamp,
    });
    await this.#dependencies.acknowledgments.publish({
      agentId: input.agentId,
      item: input.item,
      modeId: input.mode.policy.id,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      workspaceDir: input.workspaceDir,
    });

    const current = await this.#conversation(input, conversationId);
    if (current.conversation.assignmentResponse) {
      if (current.conversation.assignmentResponse.status === 'pending') {
        await this.#publish(input.agentId, conversationId, input.signal);
      }
      const reconciled = await this.#conversation(input, conversationId);
      if (
        reconciled.conversation.assignmentResponse?.status === 'published' &&
        reconciled.conversation.implementation?.status === 'pending'
      ) {
        await this.#implement({
          assignmentEventId,
          config,
          conversationId,
          lifecycleContext,
          projectionTimestamp: projection.timestamp,
          repository,
          route,
          session: input,
        });
      } else if (reconciled.conversation.implementation?.status === 'delivery-pending') {
        await this.#deliver(input, conversationId, repository);
      }
      return;
    }
    await this.#checkpointActiveTurn(input, conversationId, assignmentEventId);
    const contract = this.#dependencies.turnContracts.resolve(
      {
        eventId: 'assignment',
        lifecycleId: input.item.lifecycleId,
        modeId: input.mode.policy.id,
      },
      config,
      route.agentId,
    );
    const turn = await this.#dependencies.coordinator.run({
      config,
      contract,
      createIfMissing: true,
      ctxPayload,
      executionSurface: input.executionSurface,
      messageId,
      route,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      sourceId: assignmentEventId,
    });
    await this.#checkpointResponse(input, conversationId, assignmentEventId, turn.publication);
    if (turn.publication.status === 'candidate') {
      await this.#publish(input.agentId, conversationId, input.signal);
    }
    this.#dependencies.logger.info(
      `github-notifications: assignment response prepared agent=${route.agentId} item=${repository}#${input.item.number} publication=${turn.publication.status}`,
    );
  }

  async #implement(input: AssignmentImplementationInput): Promise<void> {
    await this.#checkpointImplementationActiveTurn(
      input.session,
      input.conversationId,
      input.assignmentEventId,
    );
    const contract = this.#dependencies.turnContracts.resolve(
      {
        eventId: 'implementation',
        lifecycleId: input.session.item.lifecycleId,
        modeId: input.session.mode.policy.id,
      },
      input.config,
      input.route.agentId,
    );
    const messageId = `implementation:${input.assignmentEventId}`;
    const body = githubNotificationImplementationCard(input.session.item.number);
    const turn = await this.#dependencies.coordinator.run({
      config: input.config,
      contract,
      createIfMissing: true,
      ctxPayload: modelTurnContext({
        body,
        lifecycleContext: input.lifecycleContext,
        messageId,
        repository: `${input.repository}#${input.session.item.number}`,
        route: input.route,
        sender: {
          from: 'agent-system:github-notifications',
          id: 'agent-system',
          isBot: true,
          isSelf: false,
          label: 'Agent System',
        },
        timestamp: input.projectionTimestamp,
      }),
      executionSurface: input.session.executionSurface,
      messageId,
      route: input.route,
      ...(input.session.signal === undefined ? {} : { signal: input.session.signal }),
      sourceId: input.assignmentEventId,
    });
    await this.#checkpointImplementationReadyForDelivery(
      input.session,
      input.conversationId,
      input.assignmentEventId,
    );
    this.#dependencies.logger.info(
      `github-notifications: assignment implementation prepared agent=${input.route.agentId} item=${input.repository}#${input.session.item.number} publication=${turn.publication.status}`,
    );
    await this.#deliver(input.session, input.conversationId, input.repository);
  }

  async #deliver(
    input: GitHubNotificationAssignmentSessionInput,
    conversationId: string,
    repository: string,
  ): Promise<void> {
    if (!input.worktree) {
      throw new Error('The GitHub assignment delivery worktree is missing.');
    }
    const receipt = await this.#dependencies.deliveries.deliver({
      agentId: input.agentId,
      item: input.item,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      workspaceDir: input.workspaceDir,
      worktree: input.worktree,
    });
    await this.#checkpointImplementationCompleted(input, conversationId);
    this.#dependencies.logger.info(
      `github-notifications: assignment delivery completed agent=${input.agentId} item=${repository}#${input.item.number} pr=${receipt.pullRequestNumber}`,
    );
  }

  async #conversation(
    input: GitHubNotificationAssignmentSessionInput,
    conversationId: string,
  ): Promise<AssignmentConversationCheckpoint> {
    const state = await this.#dependencies.conversationStateStore.read(input.agentId);
    const conversation = state?.conversations[conversationId];
    if (!state || !conversation) {
      throw new Error('The GitHub assignment conversation checkpoint is missing.');
    }
    if (
      state.workspaceDir !== input.workspaceDir ||
      conversation.itemKey !== githubWorkItemKey(input.item.repositoryNodeId, input.item.number) ||
      conversation.lifecycleId !== input.item.lifecycleId ||
      conversation.mode !== input.mode.policy.id
    ) {
      throw new Error('The GitHub assignment conversation identity is invalid.');
    }
    return { conversation, state };
  }

  async #checkpointActiveTurn(
    input: GitHubNotificationAssignmentSessionInput,
    conversationId: string,
    assignmentEventId: string,
  ): Promise<void> {
    const { conversation, state } = await this.#conversation(input, conversationId);
    if (
      conversation.activeTurn &&
      (conversation.activeTurn.eventId !== 'assignment' ||
        conversation.activeTurn.sourceId !== assignmentEventId)
    ) {
      throw new Error('Another GitHub notification model turn is active.');
    }
    const next = structuredClone(state);
    next.conversations[conversationId]!.activeTurn = {
      eventId: 'assignment',
      sourceId: assignmentEventId,
    };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #checkpointResponse(
    input: GitHubNotificationAssignmentSessionInput,
    conversationId: string,
    assignmentEventId: string,
    publication: Awaited<ReturnType<GitHubNotificationModelTurnCoordinator['run']>>['publication'],
  ): Promise<void> {
    const { conversation, state } = await this.#conversation(input, conversationId);
    if (
      conversation.activeTurn?.eventId !== 'assignment' ||
      conversation.activeTurn.sourceId !== assignmentEventId
    ) {
      throw new Error('The GitHub assignment active-turn checkpoint is missing.');
    }
    let response: GitHubNotificationPublicationState;
    if (publication.status === 'none') {
      throw new Error('The GitHub assignment response is missing its publication intent.');
    } else if (publication.status === 'withheld') {
      response = { reasonCode: publication.code, status: 'withheld' };
    } else {
      response = {
        publicText: publication.publicText,
        publicTextDigest: githubNotificationPublicTextDigest(publication.publicText),
        status: 'pending',
        target: githubNotificationPublicationTarget({
          intent: 'assignment-response',
          item: input.item,
          publicationId: assignmentEventId,
        }),
      };
    }
    const next = structuredClone(state);
    const updatedConversation = next.conversations[conversationId]!;
    delete updatedConversation.activeTurn;
    updatedConversation.assignmentResponse = response;
    if (publication.status === 'candidate') {
      updatedConversation.implementation = { status: 'pending' };
    }
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #checkpointImplementationActiveTurn(
    input: GitHubNotificationAssignmentSessionInput,
    conversationId: string,
    assignmentEventId: string,
  ): Promise<void> {
    const { conversation, state } = await this.#conversation(input, conversationId);
    if (
      conversation.assignmentResponse?.status !== 'published' ||
      conversation.implementation?.status !== 'pending' ||
      (conversation.activeTurn !== undefined &&
        (conversation.activeTurn.eventId !== 'implementation' ||
          conversation.activeTurn.sourceId !== assignmentEventId))
    ) {
      throw new Error('The GitHub assignment implementation checkpoint is missing.');
    }
    const next = structuredClone(state);
    next.conversations[conversationId]!.activeTurn = {
      eventId: 'implementation',
      sourceId: assignmentEventId,
    };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #checkpointImplementationReadyForDelivery(
    input: GitHubNotificationAssignmentSessionInput,
    conversationId: string,
    assignmentEventId: string,
  ): Promise<void> {
    const { conversation, state } = await this.#conversation(input, conversationId);
    if (
      conversation.activeTurn?.eventId !== 'implementation' ||
      conversation.activeTurn.sourceId !== assignmentEventId ||
      conversation.assignmentResponse?.status !== 'published' ||
      conversation.implementation?.status !== 'pending'
    ) {
      throw new Error('The GitHub assignment implementation active-turn checkpoint is missing.');
    }
    const next = structuredClone(state);
    const updatedConversation = next.conversations[conversationId]!;
    delete updatedConversation.activeTurn;
    updatedConversation.implementation = { status: 'delivery-pending' };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #checkpointImplementationCompleted(
    input: GitHubNotificationAssignmentSessionInput,
    conversationId: string,
  ): Promise<void> {
    const { conversation, state } = await this.#conversation(input, conversationId);
    if (
      conversation.activeTurn !== undefined ||
      conversation.assignmentResponse?.status !== 'published' ||
      conversation.implementation?.status !== 'delivery-pending'
    ) {
      throw new Error('The GitHub assignment delivery checkpoint is missing.');
    }
    const next = structuredClone(state);
    next.conversations[conversationId]!.implementation = { status: 'completed' };
    await this.#dependencies.conversationStateStore.write(next);
  }

  async #publish(agentId: string, conversationId: string, signal?: AbortSignal): Promise<void> {
    const state = await this.#dependencies.conversationStateStore.read(agentId);
    const publication = state?.conversations[conversationId]?.assignmentResponse;
    if (!state || publication?.status !== 'pending') {
      throw new Error('The GitHub assignment response publication checkpoint is missing.');
    }
    const result = await this.#dependencies.publications.publish({
      accountId: agentId,
      ...(signal === undefined ? {} : { signal }),
      target: publication.target,
      text: publication.publicText,
    });
    const current = await this.#dependencies.conversationStateStore.read(agentId);
    const currentPublication = current?.conversations[conversationId]?.assignmentResponse;
    if (!current || currentPublication?.status !== 'pending') {
      throw new Error('The GitHub assignment response publication checkpoint has changed.');
    }
    const next = structuredClone(current);
    const conversation = next.conversations[conversationId]!;
    conversation.assignmentResponse = {
      ...currentPublication,
      commentDatabaseId: result.receipt.databaseId,
      commentNodeId: result.receipt.nodeId,
      status: 'published',
    };
    await this.#dependencies.conversationStateStore.write(next);
  }
}
