import {
  buildChannelInboundEventContext,
  dispatchChannelInboundReply,
  type AssembledInboundReply,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import type { Logger } from '../../../lib/logger.ts';
import type GitHubNotificationModeRegistry from '../modes/registry.ts';
import githubNotificationCommentContext from './context/comment.ts';
import type { GitHubCanonicalIssueComment, GitHubCommentRevision } from './comment-admission.ts';
import {
  githubNotificationReplyCleanupOptions,
  type GitHubNotificationExecutionSurface,
} from './execution.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import { githubNotificationPrivateResponse } from './private-response.ts';
import type GitHubNotificationReplyCandidateStore from '../publication/reply-candidate-store.ts';
import {
  GitHubNotificationPublicationError,
  githubNotificationPublicationText,
} from '../publication/publication.ts';
import { resolveNotificationRoute, githubNotificationChannelId } from '../routing/routing.ts';
import { githubNotificationConversationId } from '../channel.ts';

export interface GitHubNotificationCommentTurnServiceDependencies {
  modes: Pick<GitHubNotificationModeRegistry, 'resolve'>;
  candidates: Pick<GitHubNotificationReplyCandidateStore, 'begin' | 'cancel' | 'finish'>;
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  logger: Logger;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationCommentTurnInput {
  agentId: string;
  comment: GitHubCanonicalIssueComment;
  executionSurface: GitHubNotificationExecutionSurface;
  item: GitHubNotificationItemState;
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
    if (!author || !worktreePath || !worktreeBranch || input.item.lifecycleId !== 'issue') {
      throw new Error('The GitHub notification comment turn is missing prepared issue context.');
    }
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
    const mode = this.#dependencies.modes.resolve('work').resolve(config, input.agentId);
    const messageId = `comment:${input.revision.revisionId}`;
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
            item: input.item,
            revision: input.revision,
            worktree: { branch: worktreeBranch, path: worktreePath },
          }),
        ],
      },
      from: `github:${author.nodeId}`,
      message: {
        body: input.comment.body,
        bodyForAgent: input.comment.body,
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
    const finalPayloads: ReplyPayload[] = [];
    const candidateIdentity = {
      agentId: route.agentId,
      conversationId: route.conversationId,
      revisionId: input.revision.revisionId,
    };
    const candidateTurn = await this.#dependencies.candidates.begin(candidateIdentity);
    let sessionRecordTask: Promise<unknown> | undefined;
    let result;
    try {
      result = await dispatchChannelInboundReply({
        accountId: route.accountId,
        agentId: route.agentId,
        afterRecord: async () => {
          if (!sessionRecordTask) {
            throw new GitHubNotificationCommentTurnError(
              'github-notification-comment-session-recording-failed',
            );
          }
          if (!(await sessionRecordTask)) {
            throw new GitHubNotificationCommentTurnError(
              'github-notification-comment-session-missing',
            );
          }
        },
        cfg: config,
        channel: githubNotificationChannelId,
        ctxPayload,
        delivery: {
          async deliver(payload, info) {
            if (info.kind === 'final') finalPayloads.push(payload);
            return { visibleReplySent: false };
          },
        },
        dispatchReplyWithBufferedBlockDispatcher:
          this.#dependencies.dispatchReplyWithBufferedBlockDispatcher,
        messageId,
        record: {
          createIfMissing: false,
          onRecordError(error) {
            throw new GitHubNotificationCommentTurnError(
              'github-notification-comment-session-recording-failed',
              { cause: error },
            );
          },
          trackSessionMetaTask(task) {
            sessionRecordTask = task;
          },
        },
        recordInboundSession: this.#dependencies.recordInboundSession,
        replyOptions: {
          ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
          ...githubNotificationReplyCleanupOptions(input.executionSurface),
          commentaryPayloadsEnabled: true,
          disableTools: mode.disableTools,
          sourceReplyDeliveryMode: 'automatic',
          suppressDefaultToolProgressMessages: true,
          suppressTyping: true,
          ...(mode.toolsAllow === undefined ? {} : { toolsAllow: mode.toolsAllow }),
        },
        routeSessionKey: route.sessionKey,
        storePath: resolveStorePath(config.session?.store, { agentId: route.agentId }),
        ...(mode.toolsAllow === undefined ? {} : { toolsAllow: mode.toolsAllow }),
      });
    } catch (error) {
      await this.#dependencies.candidates
        .cancel({ ...candidateIdentity, turnId: candidateTurn })
        .catch(() => undefined);
      const classified =
        error instanceof GitHubNotificationCommentTurnError
          ? error
          : new GitHubNotificationCommentTurnError(
              'github-notification-comment-model-dispatch-failed',
              { cause: error },
            );
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
    if (!result.dispatched || result.routeSessionKey !== route.sessionKey) {
      await this.#dependencies.candidates.cancel({ ...candidateIdentity, turnId: candidateTurn });
      throw new Error('OpenClaw did not dispatch the expected notification comment turn.');
    }
    const dispatch = result.dispatchResult;
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
    const publicCandidates = await this.#dependencies.candidates.finish({
      ...candidateIdentity,
      turnId: candidateTurn,
    });
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
