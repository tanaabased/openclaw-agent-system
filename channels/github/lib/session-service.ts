import { isAbsolute, resolve } from 'node:path';

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
import type {
  GitHubNotificationAssignmentSessions,
  GitHubNotificationAssignmentSessionInput,
} from './assignment-orchestrator.ts';
import {
  githubNotificationConversationId,
  runGitHubNotificationAssignment,
  type GitHubNotificationAssignmentEvent,
} from '../channel.ts';
import githubNotificationAssignmentNotice from '../utils/assignment-presentation.ts';
import githubNotificationCommentPrompt from '../utils/comment-context.ts';
import githubNotificationCommentReply, {
  assertGitHubNotificationCommentResponse,
} from '../utils/comment-response.ts';
import type { GitHubNotificationObservedSession } from '../utils/delivery-plan.ts';
import type { GitHubCanonicalIssueComment } from '../utils/comment-admission.ts';
import type {
  GitHubNotificationAcknowledgmentState,
  GitHubNotificationCommentRevisionState,
} from '../utils/monitor-state.ts';
import githubNotificationPlanningPrompt from '../utils/planning-context.ts';
import githubNotificationPlanningAcknowledgment, {
  assertGitHubNotificationPlanningResponse,
} from '../utils/planning-response.ts';
import {
  githubNotificationChannelId,
  resolveNotificationRoute,
  type NotificationRoutingDesiredState,
  type ResolvedNotificationRoute,
} from '../utils/routing.ts';
import type { GitHubNotificationPlanningContext } from './work-event-client.ts';
import {
  githubNotificationPublishedCommentId,
  type GitHubNotificationPublications,
} from './publication-service.ts';

export interface GitHubNotificationSessionServiceDependencies {
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  logger: Logger;
  publicationService: GitHubNotificationPublications;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationPlanningTurnInput extends GitHubNotificationAssignmentSessionInput {
  context: GitHubNotificationPlanningContext;
  onTurnAdopted(): Promise<void> | void;
}

export type GitHubNotificationPlanningTurnResult = {
  acknowledgment:
    { failureCode: string; status: 'failed' } | { commentId: number; status: 'published' };
};

export interface GitHubNotificationCommentTurnInput extends GitHubNotificationAssignmentSessionInput {
  comment: GitHubNotificationCommentRevisionState;
  context: GitHubCanonicalIssueComment;
  onTurnAdopted(): Promise<void> | void;
}

export type GitHubNotificationCommentTurnResult = {
  reply: Exclude<GitHubNotificationAcknowledgmentState, { status: 'pending' }>;
};

export interface GitHubNotificationSessionTurnInput {
  config: OpenClawConfig;
  event: GitHubNotificationAssignmentEvent;
  label: string;
  route: ResolvedNotificationRoute;
  worktreeBranch: string;
  worktreePath: string;
}

interface ResolvedAssignmentSession {
  config: OpenClawConfig;
  desired: NotificationRoutingDesiredState;
  event: GitHubNotificationAssignmentEvent;
  label: string;
  route: ResolvedNotificationRoute;
}

function requiredText(value: string, label: string, maximumLength?: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (maximumLength !== undefined && normalized.length > maximumLength) {
    throw new Error(`${label} must not exceed ${maximumLength} characters.`);
  }
  return normalized;
}

function absolutePath(value: string, label: string): string {
  const normalized = resolve(requiredText(value, label, 4096));
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return normalized;
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
  return 'github-notification-acknowledgment-publication-failed';
}

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

/** Record one assignment through OpenClaw's channel-owned session lifecycle. */
export default class GitHubNotificationSessionService implements GitHubNotificationAssignmentSessions {
  readonly #dependencies: GitHubNotificationSessionServiceDependencies;

  public constructor(dependencies: GitHubNotificationSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async recordSession(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationObservedSession> {
    const assignment = await this.#resolveAssignment(input);
    const result = await runGitHubNotificationAssignment(assignment.event, {
      config: assignment.config,
      desired: assignment.desired,
      prepareTurn: (event, route) =>
        this.prepareTurn({
          config: assignment.config,
          event,
          label: assignment.label,
          route,
          worktreeBranch: input.worktree.branch,
          worktreePath: input.worktree.path,
        }),
    });
    if (
      !result.dispatched ||
      result.admission.kind !== 'observeOnly' ||
      result.routeSessionKey !== assignment.route.sessionKey
    ) {
      throw new Error('OpenClaw did not record the expected notification session.');
    }
    return { key: result.routeSessionKey, status: 'active' };
  }

  public async planAssignment(
    input: GitHubNotificationPlanningTurnInput,
  ): Promise<GitHubNotificationPlanningTurnResult> {
    const assignment = await this.#resolveAssignment(input);
    const finalPayloads: ReplyPayload[] = [];
    let sessionRecordTask: Promise<unknown> | undefined;
    const eventId = requiredText(assignment.event.id, 'GitHub notification event ids', 256);
    const messageId = `plan:${eventId}`;
    const planning = githubNotificationPlanningPrompt({
      context: input.context,
      item: input.item,
    });
    const prompt = planning.body;
    const ctxPayload = buildChannelInboundEventContext({
      accountId: assignment.route.accountId,
      channel: githubNotificationChannelId,
      conversation: {
        id: assignment.route.conversationId,
        kind: 'direct',
        label: assignment.label,
        routePeer: { id: assignment.route.conversationId, kind: 'direct' },
      },
      extra: {
        githubItemNumber: assignment.event.itemNumber,
        githubItemType: assignment.event.itemType,
        githubRepositoryId: assignment.event.repositoryId,
        githubWorktreeBranch: input.worktree.branch,
        githubWorktreePath: input.worktree.path,
        UntrustedStructuredContext: [planning.untrustedContext],
      },
      from: `github:${assignment.event.repositoryId}`,
      message: {
        body: prompt,
        bodyForAgent: prompt,
        commandBody: '',
        inboundEventKind: 'user_request',
        rawBody: prompt,
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
        displayLabel: 'GitHub Notifications',
        id: 'github-notifications',
        isBot: true,
        name: 'GitHub Notifications',
      },
      surface: githubNotificationChannelId,
    });
    const result = await dispatchChannelInboundReply({
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
      onTurnAdopted: input.onTurnAdopted,
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
        disableTools: true,
        sourceReplyDeliveryMode: 'automatic',
        suppressDefaultToolProgressMessages: true,
        suppressTyping: true,
        toolsAllow: [],
      },
      routeSessionKey: assignment.route.sessionKey,
      storePath: resolveStorePath(assignment.config.session?.store, {
        agentId: assignment.route.agentId,
      }),
      toolsAllow: [],
    });
    if (!result.dispatched || result.routeSessionKey !== assignment.route.sessionKey) {
      throw new Error('OpenClaw did not dispatch the expected notification planning turn.');
    }
    const dispatch = result.dispatchResult;
    this.#dependencies.logger.info(
      [
        'github-notifications: planning dispatch complete',
        `agent=${assignment.route.agentId}`,
        `payloads=${finalPayloads.length}`,
        `ordinary=${finalPayloads.filter(({ isCommentary }) => isCommentary !== true).length}`,
        `commentary=${finalPayloads.filter(({ isCommentary }) => isCommentary === true).length}`,
        `final=${dispatch.counts.final ?? 0}`,
        `block=${dispatch.counts.block ?? 0}`,
        `tool=${dispatch.counts.tool ?? 0}`,
        `failed-final=${dispatch.failedCounts?.final ?? 0}`,
        `failed-block=${dispatch.failedCounts?.block ?? 0}`,
        `failed-tool=${dispatch.failedCounts?.tool ?? 0}`,
        `queued-final=${dispatch.queuedFinal === true}`,
      ].join(' '),
    );
    const planningPayload = assertGitHubNotificationPlanningResponse(finalPayloads);
    let acknowledgment: string;
    try {
      acknowledgment = githubNotificationPlanningAcknowledgment([planningPayload]);
    } catch (error) {
      return {
        acknowledgment: { failureCode: errorCode(error), status: 'failed' },
      };
    }
    try {
      const publication = await this.#dependencies.publicationService.publish({
        accountId: assignment.route.accountId,
        agentId: assignment.route.agentId,
        cfg: assignment.config,
        ctxPayload,
        info: { kind: 'final' },
        intent: 'initial-acknowledgment',
        item: input.item,
        payload: { text: acknowledgment },
        publicationId: input.delivery.assignmentEventId,
      });
      const acknowledgmentCommentId = githubNotificationPublishedCommentId(publication);
      const acknowledgmentFailureCode =
        publication.status === 'failed'
          ? errorCode(publication.error)
          : 'github-notification-acknowledgment-not-confirmed';
      return acknowledgmentCommentId === undefined
        ? {
            acknowledgment: {
              failureCode: acknowledgmentFailureCode,
              status: 'failed',
            },
          }
        : { acknowledgment: { commentId: acknowledgmentCommentId, status: 'published' } };
    } catch (error) {
      return {
        acknowledgment: { failureCode: errorCode(error), status: 'failed' },
      };
    }
  }

  public async respondToComment(
    input: GitHubNotificationCommentTurnInput,
  ): Promise<GitHubNotificationCommentTurnResult> {
    const assignment = await this.#resolveAssignment(input);
    const finalPayloads: ReplyPayload[] = [];
    let sessionRecordTask: Promise<unknown> | undefined;
    const messageId = `comment:${requiredText(
      input.comment.revisionId,
      'GitHub comment revision ids',
      255,
    )}`;
    const author = input.context.author;
    if (!author || author.nodeId !== input.comment.actorNodeId) {
      throw new Error('The GitHub notification comment author is invalid.');
    }
    const presentation = githubNotificationCommentPrompt({
      comment: input.context,
      item: { ...input.item, delivery: input.delivery },
      revision: input.comment,
    });
    const ctxPayload = buildChannelInboundEventContext({
      accountId: assignment.route.accountId,
      channel: githubNotificationChannelId,
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
        UntrustedStructuredContext: [presentation.untrustedContext],
      },
      from: `github:${author.nodeId}`,
      message: {
        body: presentation.body,
        bodyForAgent: presentation.body,
        commandBody: '',
        inboundEventKind: 'user_request',
        rawBody: presentation.body,
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
    const result = await dispatchChannelInboundReply({
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
      onTurnAdopted: input.onTurnAdopted,
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
        disableTools: true,
        sourceReplyDeliveryMode: 'automatic',
        suppressDefaultToolProgressMessages: true,
        suppressTyping: true,
        toolsAllow: [],
      },
      routeSessionKey: assignment.route.sessionKey,
      storePath: resolveStorePath(assignment.config.session?.store, {
        agentId: assignment.route.agentId,
      }),
      toolsAllow: [],
    });
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

  public prepareTurn(input: GitHubNotificationSessionTurnInput): PreparedInboundReply<void> {
    let sessionRecordTask: Promise<unknown> | undefined;
    const eventId = requiredText(input.event.id, 'GitHub notification event ids', 256);
    const label = requiredText(input.label, 'GitHub notification session labels', 120);
    const repositoryId = requiredText(
      input.event.repositoryId,
      'GitHub notification repository ids',
      256,
    );
    if (!Number.isSafeInteger(input.event.itemNumber) || input.event.itemNumber < 1) {
      throw new Error('GitHub notification item numbers must be positive safe integers.');
    }
    if (input.event.itemType !== 'issue' && input.event.itemType !== 'pull-request') {
      throw new Error('GitHub notification item types are invalid.');
    }
    absolutePath(input.route.workspaceDir, 'Agent workspace directories');
    const worktreeBranch = requiredText(
      input.worktreeBranch,
      'GitHub notification worktree branches',
      255,
    );
    const worktreePath = absolutePath(input.worktreePath, 'GitHub notification worktree paths');
    const conversationId = input.route.conversationId;
    const notification = requiredText(
      input.event.title,
      'GitHub notification assignment notices',
      2_000,
    );
    const ctxPayload = buildChannelInboundEventContext({
      accountId: input.route.accountId,
      channel: githubNotificationChannelId,
      conversation: {
        id: conversationId,
        kind: 'direct',
        label,
        routePeer: { id: conversationId, kind: 'direct' },
      },
      extra: {
        githubItemNumber: input.event.itemNumber,
        githubItemType: input.event.itemType,
        githubRepositoryId: repositoryId,
        githubWorktreeBranch: worktreeBranch,
        githubWorktreePath: worktreePath,
      },
      from: `github:${repositoryId}`,
      message: {
        body: notification,
        bodyForAgent: notification,
        commandBody: '',
        inboundEventKind: 'user_request',
        rawBody: notification,
      },
      messageId: eventId,
      reply: {
        sourceReplyDeliveryMode: 'none',
        to: conversationId,
      },
      route: {
        accountId: input.route.accountId,
        agentId: input.route.agentId,
        createIfMissing: true,
        routeSessionKey: input.route.sessionKey,
      },
      sender: {
        displayLabel: 'GitHub Notifications',
        id: 'github-notifications',
        isBot: true,
        name: 'GitHub Notifications',
      },
      surface: githubNotificationChannelId,
      timestamp: input.event.timestamp,
    });

    return {
      accountId: input.route.accountId,
      channel: githubNotificationChannelId,
      ctxPayload,
      messageId: eventId,
      observeOnlyDispatchResult: undefined,
      afterRecord: async () => {
        if (!sessionRecordTask) {
          throw new Error('OpenClaw did not expose the notification session record task.');
        }
        await sessionRecordTask;
      },
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
      routeSessionKey: input.route.sessionKey,
      runDispatch: async () => {
        throw new Error('Observe-only notification intake must not dispatch an agent turn.');
      },
      storePath: resolveStorePath(input.config.session?.store, {
        agentId: input.route.agentId,
      }),
    };
  }

  async #resolveAssignment(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<ResolvedAssignmentSession> {
    const config = await this.#dependencies.readConfig();
    const desired = {
      agentId: input.agentId,
      enabled: true,
      workspaceDir: input.workspaceDir,
    };
    const event = {
      id: input.delivery.assignmentEventId,
      itemNumber: input.item.number,
      itemType: input.item.itemType,
      repositoryId: input.item.repositoryNodeId,
      title: githubNotificationAssignmentNotice(input.item),
    };
    const route = resolveNotificationRoute(
      config,
      desired,
      githubNotificationConversationId(event),
    );
    const label =
      `${input.item.repositoryOwner}/${input.item.repositoryName}#${input.item.number} · ${input.worktree.branch}`
        .slice(0, 120)
        .trim();
    return { config, desired, event, label, route };
  }
}
