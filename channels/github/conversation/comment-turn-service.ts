import {
  buildChannelInboundEventContext,
  type AssembledInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationCommentPresentation } from '../events/comment.ts';
import githubNotificationCommentContext from './context/comment.ts';
import type { GitHubCanonicalIssueComment, GitHubCommentRevision } from './comment-admission.ts';
import type { GitHubNotificationExecutionSurface } from './execution.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import {
  GitHubNotificationModelTurnDispatcherError,
  type default as GitHubNotificationModelTurnDispatcher,
} from './model-turn-dispatcher.ts';
import { githubNotificationPrivateResponse } from './private-response.ts';
import {
  GitHubNotificationReplyCandidateStoreError,
  type default as GitHubNotificationReplyCandidateStore,
} from '../publication/reply-candidate-store.ts';
import {
  GitHubNotificationPublicationError,
  githubNotificationPublicationText,
} from '../publication/publication.ts';
import { resolveNotificationRoute, githubNotificationChannelId } from '../routing/routing.ts';
import { githubNotificationConversationId } from '../channel.ts';
import type GitHubNotificationTurnContractResolver from './turn-contract.ts';
import type { GitHubNotificationTurnIdentity } from './turn-identity.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';

export interface GitHubNotificationCommentTurnServiceDependencies {
  candidates: Pick<GitHubNotificationReplyCandidateStore, 'begin' | 'cancel' | 'finish'>;
  dispatcher: Pick<GitHubNotificationModelTurnDispatcher, 'dispatch'>;
  logger: Logger;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  turnContracts: Pick<GitHubNotificationTurnContractResolver, 'resolve'>;
}

export interface GitHubNotificationCommentTurnInput {
  agentId: string;
  comment: GitHubCanonicalIssueComment;
  executionSurface: GitHubNotificationExecutionSurface;
  item: GitHubNotificationItemState;
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
  publication: { status: 'candidate'; publicText: string } | { status: 'withheld'; code: string };
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

function commentDispatchError(error: unknown): Error {
  if (!(error instanceof GitHubNotificationModelTurnDispatcherError)) {
    return new GitHubNotificationCommentTurnError(
      'github-notification-comment-model-dispatch-failed',
      { cause: error },
    );
  }
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
    const presentation = githubNotificationCommentPresentation(input.comment.body);
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
        rawBody: presentation,
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
    const candidateIdentity = {
      agentId: route.agentId,
      conversationId: route.conversationId,
      identity: contract.identity,
      sourceId: input.revision.revisionId,
    };
    const candidateTurn = await this.#dependencies.candidates.begin(candidateIdentity);
    let turnResult;
    try {
      turnResult = await this.#dependencies.dispatcher.dispatch({
        config,
        contract,
        ctxPayload,
        executionSurface: input.executionSurface,
        messageId,
        route,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      await this.#dependencies.candidates
        .cancel({ ...candidateIdentity, turnId: candidateTurn })
        .catch(() => undefined);
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
    const { dispatch, finalPayloads } = turnResult;
    this.#dependencies.logger.info(
      [
        'github-notifications: comment dispatch complete',
        `agent=${route.agentId}`,
        `payloads=${finalPayloads.length}`,
        `final=${dispatch.counts.final ?? 0}`,
        `block=${dispatch.counts.block ?? 0}`,
        `tool=${dispatch.counts.tool ?? 0}`,
        `queued-final=${dispatch.queuedFinal === true}`,
      ].join(' '),
    );
    let publicCandidates: string[];
    try {
      publicCandidates = await this.#dependencies.candidates.finish({
        ...candidateIdentity,
        turnId: candidateTurn,
      });
    } catch (error) {
      throw new GitHubNotificationCommentTurnError(
        error instanceof GitHubNotificationReplyCandidateStoreError &&
          error.code === 'reply-turn-prompt-selection-missing'
          ? 'github-notification-comment-prompt-selection-missing'
          : 'github-notification-comment-reply-candidate-failed',
        { cause: error },
      );
    }
    const privateText = githubNotificationPrivateResponse(finalPayloads);
    let publication: GitHubNotificationCommentTurnResult['publication'];
    if (publicCandidates.length === 0) {
      publication = {
        status: 'withheld',
        code: 'github-notification-publication-candidate-missing',
      };
    } else if (publicCandidates.length !== 1) {
      publication = {
        status: 'withheld',
        code: 'github-notification-publication-candidate-duplicate',
      };
    } else {
      try {
        publication = {
          status: 'candidate',
          publicText: githubNotificationPublicationText('github-reply', [
            { text: publicCandidates[0] },
          ]),
        };
      } catch (error) {
        publication = {
          status: 'withheld',
          code:
            error instanceof GitHubNotificationPublicationError
              ? error.code
              : 'github-notification-publication-validation-failed',
        };
      }
    }
    return {
      accountId: route.accountId,
      agentId: route.agentId,
      config,
      ctxPayload,
      privateText,
      publication,
    };
  }
}
