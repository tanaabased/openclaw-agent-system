import {
  buildChannelInboundEventContext,
  dispatchChannelInboundReply,
  type AssembledInboundReply,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import type { Logger } from '../../../lib/logger.ts';
import type GitHubNotificationCapabilityRegistry from '../capabilities/registry.ts';
import githubNotificationWorkCommentInstructions from '../messages/instructions/work-comment.ts';
import type {
  GitHubCanonicalIssueComment,
  GitHubCommentRevision,
} from '../utils/comment-admission.ts';
import type { GitHubNotificationItemState } from '../utils/monitor-state.ts';
import {
  assertGitHubNotificationResponse,
  githubNotificationResponsePublication,
} from '../utils/response-publication.ts';
import { resolveNotificationRoute, githubNotificationChannelId } from '../utils/routing.ts';
import { githubNotificationConversationId } from '../channel.ts';

export interface GitHubNotificationCommentTurnServiceDependencies {
  capabilities: Pick<GitHubNotificationCapabilityRegistry, 'resolve'>;
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  enqueueNextTurnInjection: OpenClawPluginApi['session']['workflow']['enqueueNextTurnInjection'];
  logger: Logger;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationCommentTurnInput {
  agentId: string;
  comment: GitHubCanonicalIssueComment;
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
  publicText: string;
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
    const capability = this.#dependencies.capabilities
      .resolve('work')
      .resolve(config, input.agentId);
    const messageId = `comment:${input.revision.revisionId}`;
    const instructionIdempotencyKey = `github-comment:${input.revision.revisionId}`;
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
          {
            comment: {
              databaseId: input.comment.databaseId,
              nodeId: input.comment.nodeId,
              revisionId: input.revision.revisionId,
            },
            item: {
              lifecycleId: input.item.lifecycleId,
              number: input.item.number,
              repositoryName: input.item.repositoryName,
              repositoryOwner: input.item.repositoryOwner,
            },
            worktree: { branch: worktreeBranch, path: worktreePath },
          },
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
        createIfMissing: true,
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
    let sessionRecordTask: Promise<unknown> | undefined;
    const result = await dispatchChannelInboundReply({
      accountId: route.accountId,
      agentId: route.agentId,
      afterRecord: async () => {
        if (!sessionRecordTask) {
          throw new Error('OpenClaw did not expose the notification session record task.');
        }
        await sessionRecordTask;
        const injection = await this.#dependencies.enqueueNextTurnInjection({
          idempotencyKey: instructionIdempotencyKey,
          placement: 'append_context',
          sessionKey: route.sessionKey,
          text: githubNotificationWorkCommentInstructions,
        });
        if (!injection.id) {
          throw new Error('OpenClaw did not accept the notification turn instructions.');
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
        createIfMissing: true,
        onRecordError(error) {
          throw error;
        },
        trackSessionMetaTask(task) {
          sessionRecordTask = task;
        },
      },
      recordInboundSession: this.#dependencies.recordInboundSession,
      replyOptions: {
        ...(input.signal === undefined ? {} : { abortSignal: input.signal }),
        commentaryPayloadsEnabled: true,
        disableTools: capability.disableTools,
        sourceReplyDeliveryMode: 'automatic',
        suppressDefaultToolProgressMessages: true,
        suppressTyping: true,
        ...(capability.toolsAllow === undefined ? {} : { toolsAllow: capability.toolsAllow }),
      },
      routeSessionKey: route.sessionKey,
      storePath: resolveStorePath(config.session?.store, { agentId: route.agentId }),
      ...(capability.toolsAllow === undefined ? {} : { toolsAllow: capability.toolsAllow }),
    });
    if (!result.dispatched || result.routeSessionKey !== route.sessionKey) {
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
    const response = assertGitHubNotificationResponse(finalPayloads);
    return {
      accountId: route.accountId,
      agentId: route.agentId,
      config,
      ctxPayload,
      publicText: githubNotificationResponsePublication(response, 'github-reply'),
    };
  }
}
