import {
  buildChannelInboundEventContext,
  type AssembledInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationConversationId } from '../channel.ts';
import { githubNotificationAssignmentCard } from '../events/assignment.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import resolveGitHubNotificationLifecycleEventSupport from '../lifecycles/event-support.ts';
import type {
  GitHubNotificationLifecycle,
  GitHubNotificationLifecycleWorktree,
} from '../lifecycles/types.ts';
import type { GitHubNotificationMode } from '../modes/types.ts';
import type { GitHubNotificationItemContext } from '../provider/work-event-client.ts';
import { githubNotificationChannelId, resolveNotificationRoute } from '../routing/routing.ts';
import githubNotificationAssignmentContext from './context/assignment.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import {
  GitHubNotificationModelTurnCoordinatorError,
  type GitHubNotificationModelTurnPublication,
  type default as GitHubNotificationModelTurnCoordinator,
} from './model-turn-coordinator.ts';
import { GitHubNotificationModelTurnDispatcherError } from './model-turn-dispatcher.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';

export interface GitHubNotificationAssignmentTurnServiceDependencies {
  coordinator: Pick<GitHubNotificationModelTurnCoordinator, 'run'>;
  logger: Logger;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'resolve'>;
}

export interface GitHubNotificationAssignmentTurnInput {
  agentId: string;
  executionSurface: GitHubNotificationExecutionSurface;
  item: GitHubNotificationItemState;
  itemContext: GitHubNotificationItemContext;
  lifecycle: GitHubNotificationLifecycle;
  mode: Pick<GitHubNotificationMode, 'policy'>;
  signal?: AbortSignal;
  sourceId: string;
  workspaceDir: string;
  worktree: GitHubNotificationLifecycleWorktree;
}

export interface GitHubNotificationAssignmentTurnResult {
  privateText: string;
  publication: GitHubNotificationModelTurnPublication;
}

export class GitHubNotificationAssignmentTurnError extends Error {
  override name = 'GitHubNotificationAssignmentTurnError';

  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super('The GitHub assignment planning turn could not be dispatched.', options);
  }
}

function assignmentDispatchError(error: GitHubNotificationModelTurnDispatcherError): Error {
  if (error.code === 'github-notification-model-turn-dispatch-unconfirmed') {
    return new Error('OpenClaw did not dispatch the expected assignment planning turn.');
  }
  const suffix =
    error.code === 'github-notification-model-turn-session-missing'
      ? 'session-missing'
      : error.code === 'github-notification-model-turn-session-recording-failed'
        ? 'session-recording-failed'
        : 'model-dispatch-failed';
  return new GitHubNotificationAssignmentTurnError(`github-notification-assignment-${suffix}`, {
    cause: error.cause ?? error,
  });
}

/** Dispatch one prepared issue assignment into its first model-backed planning turn. */
export default class GitHubNotificationAssignmentTurnService {
  readonly #dependencies: GitHubNotificationAssignmentTurnServiceDependencies;

  constructor(dependencies: GitHubNotificationAssignmentTurnServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async respond(
    input: GitHubNotificationAssignmentTurnInput,
  ): Promise<GitHubNotificationAssignmentTurnResult> {
    const intake = input.item.intake;
    if (!intake || intake.assignmentEventId !== input.sourceId) {
      throw new Error('The GitHub assignment planning turn is missing its intake identity.');
    }
    const support = resolveGitHubNotificationLifecycleEventSupport(input.lifecycle, 'assignment');
    if (!support.session) {
      throw new Error('The GitHub lifecycle does not support assignment planning sessions.');
    }
    const config = await this.#dependencies.readConfig();
    const contract = this.#dependencies.turnContracts.resolve(
      {
        eventId: 'assignment',
        lifecycleId: input.item.lifecycleId,
        modeId: input.mode.policy.id,
      },
      config,
      input.agentId,
    );
    const projection = support.session.project(input.item);
    const lifecycleContext = input.lifecycle.context.project({
      item: input.item,
      worktree: input.worktree,
    });
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
    const body = githubNotificationAssignmentCard(projection, input.mode.policy.label);
    const messageId = `assignment:${input.sourceId}`;
    const ctxPayload: AssembledInboundReply['ctxPayload'] = buildChannelInboundEventContext({
      accountId: route.accountId,
      channel: githubNotificationChannelId,
      channelContext: {
        chat: { id: route.conversationId },
        sender: { id: projection.sender.id },
      },
      conversation: {
        id: route.conversationId,
        kind: 'direct',
        label: `${repository}#${input.item.number}`,
        routePeer: { id: route.conversationId, kind: 'direct' },
      },
      extra: {
        UntrustedStructuredContext: [
          githubNotificationAssignmentContext({
            itemContext: input.itemContext,
            lifecycleContext,
          }),
        ],
      },
      from: `github:${projection.sender.id}`,
      message: {
        body,
        bodyForAgent: body,
        commandBody: '',
        inboundEventKind: 'room_event',
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
        displayLabel: projection.sender.label,
        id: projection.sender.id,
        isBot: false,
        isSelf: false,
        name: projection.sender.label,
        username: projection.sender.label,
      },
      surface: githubNotificationChannelId,
      timestamp: projection.timestamp,
    });
    let result;
    try {
      result = await this.#dependencies.coordinator.run({
        config,
        contract,
        ctxPayload,
        executionSurface: input.executionSurface,
        messageId,
        route,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        sourceId: input.sourceId,
      });
    } catch (error) {
      if (error instanceof GitHubNotificationModelTurnCoordinatorError) {
        throw new GitHubNotificationAssignmentTurnError(
          error.code === 'github-notification-model-turn-prompt-selection-missing'
            ? 'github-notification-assignment-prompt-selection-missing'
            : 'github-notification-assignment-reply-candidate-failed',
          { cause: error.cause ?? error },
        );
      }
      if (!(error instanceof GitHubNotificationModelTurnDispatcherError)) throw error;
      const classified = assignmentDispatchError(error);
      if (!(classified instanceof GitHubNotificationAssignmentTurnError)) throw classified;
      this.#dependencies.logger.warn(
        [
          'github-notifications: assignment planning turn failed',
          `agent=${route.agentId}`,
          `item=${repository}#${input.item.number}`,
          `code=${classified.code}`,
        ].join(' '),
      );
      throw classified;
    }
    this.#dependencies.logger.info(
      [
        'github-notifications: assignment planning dispatch complete',
        `agent=${route.agentId}`,
        `payloads=${result.finalPayloadCount}`,
        `final=${result.dispatch.counts.final ?? 0}`,
        `block=${result.dispatch.counts.block ?? 0}`,
        `tool=${result.dispatch.counts.tool ?? 0}`,
      ].join(' '),
    );
    return { privateText: result.privateText, publication: result.publication };
  }
}
