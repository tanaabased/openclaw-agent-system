import {
  buildChannelInboundEventContext,
  dispatchChannelInboundReply,
  type AssembledInboundReply,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import type { Logger } from '../../../lib/logger.ts';
import type { GitHubNotificationAssignmentSessionInput } from './assignment-orchestrator.ts';
import {
  githubNotificationRequiredText,
  type default as GitHubNotificationAssignmentSessionService,
} from './assignment-session-service.ts';
import githubNotificationCapabilityPolicy from './message-capability-policy.ts';
import resolveGitHubNotificationMessage from './message-registry.ts';
import type { GitHubNotificationPlanningContext } from './work-event-client.ts';
import githubNotificationPlanningPrompt from '../utils/planning-context.ts';
import { assertGitHubNotificationPlanningResponse } from '../utils/planning-response.ts';
import { githubNotificationChannelId } from '../utils/routing.ts';

export interface GitHubNotificationPlanningTurnServiceDependencies {
  assignmentSessions: Pick<GitHubNotificationAssignmentSessionService, 'resolve'>;
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  logger: Logger;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationPlanningTurnInput extends GitHubNotificationAssignmentSessionInput {
  context: GitHubNotificationPlanningContext;
  onTurnAdopted(): Promise<void> | void;
}

export interface GitHubNotificationPlanningTurnResult {
  status: 'planned';
}

/** Dispatch one planning turn with presentation, context, instructions, and capability separated. */
export default class GitHubNotificationPlanningTurnService {
  readonly #dependencies: GitHubNotificationPlanningTurnServiceDependencies;

  public constructor(dependencies: GitHubNotificationPlanningTurnServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async planAssignment(
    input: GitHubNotificationPlanningTurnInput,
  ): Promise<GitHubNotificationPlanningTurnResult> {
    const assignment = await this.#dependencies.assignmentSessions.resolve(input);
    const finalPayloads: ReplyPayload[] = [];
    let sessionRecordTask: Promise<unknown> | undefined;
    const eventId = githubNotificationRequiredText(
      assignment.event.id,
      'GitHub notification event ids',
      256,
    );
    const messageId = `plan:${eventId}`;
    const planning = githubNotificationPlanningPrompt({
      context: input.context,
      item: input.item,
    });
    const definition = resolveGitHubNotificationMessage(planning.request);
    const capability = githubNotificationCapabilityPolicy(definition.capability);
    const ctxPayload = buildChannelInboundEventContext({
      accountId: assignment.route.accountId,
      channel: githubNotificationChannelId,
      channelContext: {
        agentSystemGitHubNotification: planning.request,
        chat: { id: assignment.route.conversationId },
        sender: { id: 'github-notifications' },
      },
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
        ...assignment.workContext,
        UntrustedStructuredContext: [planning.untrustedContext],
      },
      from: `github:${assignment.event.repositoryId}`,
      message: {
        body: planning.body,
        bodyForAgent: planning.body,
        commandBody: '',
        inboundEventKind: 'user_request',
        rawBody: planning.body,
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
        disableTools: capability.disableTools,
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
    assertGitHubNotificationPlanningResponse(finalPayloads);
    return { status: 'planned' };
  }
}
