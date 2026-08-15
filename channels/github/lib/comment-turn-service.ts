import {
  buildChannelInboundEventContext,
  dispatchChannelInboundReply,
  type AssembledInboundReply,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import type { Logger } from '../../../lib/logger.ts';
import {
  githubNotificationRequiredText,
  type GitHubNotificationAssignmentSessionInput,
  type default as GitHubNotificationAssignmentSessionService,
} from './assignment-session-service.ts';
import githubNotificationCapabilityPolicy from './message-capability-policy.ts';
import resolveGitHubNotificationMessage from './message-registry.ts';
import type GitHubNotificationPromptInstructionService from './prompt-instruction-service.ts';
import {
  githubNotificationPublishedCommentId,
  type GitHubNotificationPublications,
} from './publication-service.ts';
import type { GitHubCanonicalIssueComment } from '../utils/comment-admission.ts';
import githubNotificationCommentPrompt from '../utils/comment-context.ts';
import githubNotificationCommentReply, {
  assertGitHubNotificationCommentResponse,
} from '../utils/comment-response.ts';
import type {
  GitHubNotificationCommentRevisionState,
  GitHubNotificationPublicationState,
} from '../utils/monitor-state.ts';
import { githubNotificationChannelId } from '../utils/routing.ts';

export interface GitHubNotificationCommentTurnServiceDependencies {
  assignmentSessions: Pick<GitHubNotificationAssignmentSessionService, 'resolve'>;
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  logger: Logger;
  promptInstructions: Pick<GitHubNotificationPromptInstructionService, 'prepare'>;
  publicationService: GitHubNotificationPublications;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationCommentTurnInput extends GitHubNotificationAssignmentSessionInput {
  comment: GitHubNotificationCommentRevisionState;
  context: GitHubCanonicalIssueComment;
  onTurnAdopted(): Promise<void> | void;
}

export type GitHubNotificationCommentTurnResult = {
  reply: Exclude<GitHubNotificationPublicationState, { status: 'pending' }>;
};

function commentErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('github-notification-')
  ) {
    return error.code;
  }
  return 'github-notification-reply-publication-failed';
}

/** Dispatch one admitted direct comment and publish only its validated candidate. */
export default class GitHubNotificationCommentTurnService {
  readonly #dependencies: GitHubNotificationCommentTurnServiceDependencies;

  public constructor(dependencies: GitHubNotificationCommentTurnServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async respondToComment(
    input: GitHubNotificationCommentTurnInput,
  ): Promise<GitHubNotificationCommentTurnResult> {
    const assignment = await this.#dependencies.assignmentSessions.resolve(input);
    const finalPayloads: ReplyPayload[] = [];
    let sessionRecordTask: Promise<unknown> | undefined;
    const messageId = `comment:${githubNotificationRequiredText(
      input.comment.revisionId,
      'GitHub comment revision ids',
      255,
    )}`;
    const author = input.context.author;
    if (!author || author.nodeId !== input.comment.actorNodeId) {
      throw new Error('The GitHub notification comment author is invalid.');
    }
    const comment = githubNotificationCommentPrompt({
      comment: input.context,
      item: { ...input.item, delivery: input.delivery },
      revision: input.comment,
    });
    const instructionRun = this.#dependencies.promptInstructions.prepare(comment.request);
    const definition = resolveGitHubNotificationMessage(comment.request);
    const capability = githubNotificationCapabilityPolicy(definition.capability);
    const ctxPayload = buildChannelInboundEventContext({
      accountId: assignment.route.accountId,
      channel: githubNotificationChannelId,
      channelContext: {
        chat: {
          id: assignment.route.conversationId,
        },
        sender: { id: author.nodeId },
      },
      conversation: {
        id: assignment.route.conversationId,
        kind: 'direct',
        label: assignment.label,
        routePeer: { id: assignment.route.conversationId, kind: 'direct' },
      },
      extra: {
        githubCommentId: input.comment.commentDatabaseId,
        githubCommentNodeId: input.comment.commentNodeId,
        githubCommentRevisionId: input.comment.revisionId,
        githubItemNumber: assignment.event.itemNumber,
        githubItemType: assignment.event.itemType,
        githubRepositoryId: assignment.event.repositoryId,
        UntrustedStructuredContext: [comment.untrustedContext],
      },
      from: `github:${author.nodeId}`,
      message: {
        body: comment.body,
        bodyForAgent: comment.body,
        commandBody: '',
        inboundEventKind: 'user_request',
        rawBody: comment.body,
      },
      messageId,
      reply: {
        sourceReplyDeliveryMode: 'none',
        to: assignment.route.conversationId,
      },
      route: {
        accountId: assignment.route.accountId,
        agentId: assignment.route.agentId,
        createIfMissing: false,
        routeSessionKey: assignment.route.sessionKey,
      },
      sender: {
        displayLabel: author.login,
        id: author.nodeId,
        isBot: false,
        name: author.login,
      },
      surface: githubNotificationChannelId,
      timestamp: Date.parse(input.context.updatedAt),
    });
    let result;
    try {
      result = await dispatchChannelInboundReply({
        accountId: assignment.route.accountId,
        agentId: assignment.route.agentId,
        afterRecord: async () => {
          if (!sessionRecordTask) {
            throw new Error('OpenClaw did not expose the notification session record task.');
          }
          await sessionRecordTask;
        },
        cfg: assignment.config,
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
        onTurnAdopted: async () => {
          instructionRun.adopt();
          await input.onTurnAdopted();
        },
        record: {
          createIfMissing: false,
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
          runId: instructionRun.runId,
          sourceReplyDeliveryMode: 'automatic',
          suppressDefaultToolProgressMessages: true,
          suppressTyping: true,
          toolsAllow: capability.toolsAllow,
        },
        routeSessionKey: assignment.route.sessionKey,
        storePath: resolveStorePath(assignment.config.session?.store, {
          agentId: assignment.route.agentId,
        }),
        toolsAllow: capability.toolsAllow,
      });
    } catch (error) {
      instructionRun.clear();
      throw error;
    }
    if (!result.dispatched || result.routeSessionKey !== assignment.route.sessionKey) {
      throw new Error('OpenClaw did not dispatch the expected notification comment turn.');
    }
    const dispatch = result.dispatchResult;
    this.#dependencies.logger.info(
      [
        'github-notifications: comment dispatch complete',
        `agent=${assignment.route.agentId}`,
        `payloads=${finalPayloads.length}`,
        `final=${dispatch.counts.final ?? 0}`,
        `block=${dispatch.counts.block ?? 0}`,
        `tool=${dispatch.counts.tool ?? 0}`,
        `failed-final=${dispatch.failedCounts?.final ?? 0}`,
        `failed-block=${dispatch.failedCounts?.block ?? 0}`,
        `failed-tool=${dispatch.failedCounts?.tool ?? 0}`,
        `queued-final=${dispatch.queuedFinal === true}`,
      ].join(' '),
    );
    let reply: string;
    try {
      const response = assertGitHubNotificationCommentResponse(finalPayloads);
      reply = githubNotificationCommentReply(response);
    } catch (error) {
      return { reply: { failureCode: commentErrorCode(error), status: 'failed' } };
    }
    try {
      const publication = await this.#dependencies.publicationService.publish({
        accountId: assignment.route.accountId,
        agentId: assignment.route.agentId,
        cfg: assignment.config,
        ctxPayload,
        info: { kind: 'final' },
        intent: 'github-reply',
        item: input.item,
        payload: { text: reply },
        publicationId: input.comment.revisionId,
      });
      const commentId = githubNotificationPublishedCommentId(publication);
      return commentId === undefined
        ? {
            reply: {
              failureCode:
                publication.status === 'failed'
                  ? commentErrorCode(publication.error)
                  : 'github-notification-reply-not-confirmed',
              status: 'failed',
            },
          }
        : { reply: { commentId, status: 'published' } };
    } catch (error) {
      return { reply: { failureCode: commentErrorCode(error), status: 'failed' } };
    }
  }
}
