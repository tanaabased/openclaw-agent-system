import {
  buildChannelInboundEventContext,
  type AssembledInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import { listAgentEntries } from 'openclaw/plugin-sdk/agent-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationCommentPresentation } from '../events/comment.ts';
import githubNotificationCommentContext from './context/comment.ts';
import type {
  GitHubCanonicalIssueComment,
  GitHubCommentMention,
  GitHubCommentRevision,
} from './comment-admission.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import {
  GitHubNotificationModelTurnCoordinatorError,
  type GitHubNotificationModelTurnPublication,
  type default as GitHubNotificationModelTurnCoordinator,
} from './model-turn-coordinator.ts';
import { GitHubNotificationModelTurnDispatcherError } from './model-turn-dispatcher.ts';
import { resolveNotificationRoute, githubNotificationChannelId } from '../routing/routing.ts';
import { githubNotificationConversationId } from '../channel.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';
import type { GitHubNotificationTurnIdentity } from './turn-identity.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';

export interface GitHubNotificationCommentTurnServiceDependencies {
  coordinator: Pick<GitHubNotificationModelTurnCoordinator, 'run'>;
  logger: Logger;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'resolve'>;
}

export interface GitHubNotificationCommentTurnInput {
  agentId: string;
  comment: GitHubCanonicalIssueComment;
  executionSurface: GitHubNotificationExecutionSurface;
  item: GitHubNotificationItemState;
  mentions: readonly GitHubCommentMention[];
  modeId: GitHubNotificationModeId;
  revision: GitHubCommentRevision;
  signal?: AbortSignal;
  workspaceDir: string;
}

export interface GitHubNotificationCommentTurnResult {
  accountId: string;
  agentId: string;
  config: OpenClawConfig;
  ctxPayload: AssembledInboundReply['ctxPayload'];
  privateText: string;
  publication: GitHubNotificationModelTurnPublication;
}

export class GitHubNotificationCommentTurnError extends Error {
  override name = 'GitHubNotificationCommentTurnError';

  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super('The GitHub notification comment turn could not be dispatched.', options);
  }
}

function commentDispatchError(error: GitHubNotificationModelTurnDispatcherError): Error {
  if (error.code === 'github-notification-model-turn-dispatch-unconfirmed') {
    return new Error('OpenClaw did not dispatch the expected notification comment turn.');
  }
  if (error.code === 'github-notification-model-turn-session-missing') {
    return new GitHubNotificationCommentTurnError('github-notification-comment-session-missing');
  }
  if (error.code === 'github-notification-model-turn-session-recording-failed') {
    return new GitHubNotificationCommentTurnError(
      'github-notification-comment-session-recording-failed',
      error.cause === undefined ? undefined : { cause: error.cause },
    );
  }
  return new GitHubNotificationCommentTurnError(
    'github-notification-comment-model-dispatch-failed',
    { cause: error.cause ?? error },
  );
}

function normalizedAgentId(agentId: string): string {
  return agentId.trim().toLowerCase();
}

function agentPresentation(config: OpenClawConfig, agentId: string) {
  const agent = listAgentEntries(config).find(
    ({ id }) => normalizedAgentId(id) === normalizedAgentId(agentId),
  );
  return {
    emoji: agent?.identity?.emoji?.trim() || '🤖',
    label: agent?.identity?.name?.trim() || agentId,
  };
}

function controlUiAgentsPath(config: OpenClawConfig): string {
  const configured = config.gateway?.controlUi?.basePath?.trim() ?? '';
  const rooted =
    configured && configured !== '/' ? `/${configured.replace(/^\/+|\/+$/gu, '')}` : '';
  return `${rooted}/agents`;
}

function commentPermalink(item: GitHubNotificationItemState, databaseId: number): string {
  const path = item.itemType === 'pull-request' ? 'pull' : 'issues';
  return `https://github.com/${item.repositoryOwner}/${item.repositoryName}/${path}/${item.number}#issuecomment-${databaseId}`;
}

/** Dispatch one admitted direct comment and retain the complete private response. */
export default class GitHubNotificationCommentTurnService {
  readonly #dependencies: GitHubNotificationCommentTurnServiceDependencies;

  constructor(dependencies: GitHubNotificationCommentTurnServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async respond(
    input: GitHubNotificationCommentTurnInput,
  ): Promise<GitHubNotificationCommentTurnResult> {
    const author = input.comment.author;
    const worktreePath = input.item.intake?.worktreePath;
    const worktreeBranch = input.item.intake?.worktreeBranch;
    if (!author) {
      throw new Error('The GitHub notification comment turn is missing its trusted author.');
    }
    const config = await this.#dependencies.readConfig();
    const identity: GitHubNotificationTurnIdentity = {
      eventId: 'comment',
      lifecycleId: input.item.lifecycleId,
      modeId: input.modeId,
    };
    const contract = this.#dependencies.turnContracts.resolve(identity, config, input.agentId);
    const lifecycleContext = contract.lifecycle.context.project({
      item: input.item,
      ...(worktreePath && worktreeBranch
        ? { worktree: { branch: worktreeBranch, path: worktreePath } }
        : {}),
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
    const messageId = `comment:${input.revision.revisionId}`;
    const agent = agentPresentation(config, route.agentId);
    const presentation = githubNotificationCommentPresentation({
      agent: {
        ...agent,
        url: controlUiAgentsPath(config),
      },
      author: {
        label: author.login,
        url: `https://github.com/${author.login}`,
      },
      body: input.comment.body,
      item: {
        label: `${input.item.repositoryOwner}/${input.item.repositoryName}#${input.item.number}`,
        url: commentPermalink(input.item, input.comment.databaseId),
      },
      mentions: input.mentions,
    });
    const ctxPayload = buildChannelInboundEventContext({
      accountId: route.accountId,
      channel: githubNotificationChannelId,
      channelContext: {
        chat: { id: route.conversationId },
        sender: { id: author.nodeId },
      },
      conversation: {
        id: route.conversationId,
        kind: 'direct',
        label: `${input.item.repositoryOwner}/${input.item.repositoryName}#${input.item.number}`,
        routePeer: { id: route.conversationId, kind: 'direct' },
      },
      extra: {
        UntrustedStructuredContext: [
          githubNotificationCommentContext({
            comment: input.comment,
            lifecycleContext,
            revision: input.revision,
          }),
        ],
      },
      from: `github:${author.nodeId}`,
      message: {
        body: presentation,
        bodyForAgent: presentation,
        commandBody: '',
        inboundEventKind: 'user_request',
        rawBody: input.comment.body,
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
        displayLabel: author.login,
        id: author.nodeId,
        isBot: false,
        isSelf: false,
        name: author.login,
        username: author.login,
      },
      surface: githubNotificationChannelId,
      timestamp: Date.parse(input.comment.updatedAt),
    });
    let turnResult;
    try {
      turnResult = await this.#dependencies.coordinator.run({
        config,
        contract,
        createIfMissing: false,
        ctxPayload,
        executionSurface: input.executionSurface,
        messageId,
        route,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        sourceId: input.revision.revisionId,
      });
    } catch (error) {
      if (error instanceof GitHubNotificationModelTurnCoordinatorError) {
        throw new GitHubNotificationCommentTurnError(
          error.code === 'github-notification-model-turn-prompt-selection-missing'
            ? 'github-notification-comment-prompt-selection-missing'
            : 'github-notification-comment-reply-candidate-failed',
          { cause: error.cause ?? error },
        );
      }
      if (!(error instanceof GitHubNotificationModelTurnDispatcherError)) throw error;
      const classified = commentDispatchError(error);
      if (!(classified instanceof GitHubNotificationCommentTurnError)) throw classified;
      this.#dependencies.logger.warn(
        [
          'github-notifications: comment turn failed',
          `agent=${route.agentId}`,
          `item=${input.item.repositoryOwner}/${input.item.repositoryName}#${input.item.number}`,
          `revision=${input.revision.revisionId}`,
          `code=${classified.code}`,
        ].join(' '),
      );
      throw classified;
    }
    const { dispatch, finalPayloadCount } = turnResult;
    this.#dependencies.logger.info(
      [
        'github-notifications: comment dispatch complete',
        `agent=${route.agentId}`,
        `payloads=${finalPayloadCount}`,
        `final=${dispatch.counts.final ?? 0}`,
        `block=${dispatch.counts.block ?? 0}`,
        `tool=${dispatch.counts.tool ?? 0}`,
        `queued-final=${dispatch.queuedFinal === true}`,
      ].join(' '),
    );
    return {
      accountId: route.accountId,
      agentId: route.agentId,
      config,
      ctxPayload,
      privateText: turnResult.privateText,
      publication: turnResult.publication,
    };
  }
}
