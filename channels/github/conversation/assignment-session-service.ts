import {
  buildChannelInboundEventContext,
  runPreparedInboundReply,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import type { Logger } from '../../../lib/logger.ts';
import githubNotificationAssignmentContext from './context/assignment.ts';
import githubNotificationCard, { githubNotificationMarkdownText } from './presentation/card.ts';
import type { GitHubNotificationItemState } from '../intake/monitor/state.ts';
import { githubNotificationConversationId } from '../channel.ts';
import { githubNotificationChannelId, resolveNotificationRoute } from '../routing/routing.ts';

export interface GitHubNotificationAssignmentSessionServiceDependencies {
  logger: Logger;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationAssignmentSessionInput {
  agentId: string;
  item: GitHubNotificationItemState;
  workspaceDir: string;
  worktree: { branch: string; path: string };
}

function issueUrl(item: GitHubNotificationItemState): string {
  return `https://github.com/${encodeURIComponent(item.repositoryOwner)}/${encodeURIComponent(item.repositoryName)}/issues/${item.number}`;
}

function actorUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

/** Prepare one issue assignment's deterministic OpenClaw session without a model turn. */
export default class GitHubNotificationAssignmentSessionService {
  readonly #dependencies: GitHubNotificationAssignmentSessionServiceDependencies;

  constructor(dependencies: GitHubNotificationAssignmentSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(input: GitHubNotificationAssignmentSessionInput): Promise<void> {
    const actorLogin = input.item.assignmentActorLogin?.trim();
    const actorNodeId = input.item.assignmentActorNodeId?.trim();
    if (
      input.item.lifecycleId !== 'issue' ||
      input.item.itemType !== 'issue' ||
      !actorLogin ||
      !actorNodeId
    ) {
      throw new Error('The GitHub issue assignment session is missing trusted assignment context.');
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
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    const body = githubNotificationCard({
      emoji: '📥',
      mode: 'Work',
      summary: `[@${githubNotificationMarkdownText(actorLogin)}](${actorUrl(actorLogin)}) assigned you [${githubNotificationMarkdownText(`${repository}#${input.item.number}`)}](${issueUrl(input.item)}).`,
      title: 'Issue assignment received',
    });
    const ctxPayload = buildChannelInboundEventContext({
      accountId: route.accountId,
      channel: githubNotificationChannelId,
      channelContext: {
        chat: { id: route.conversationId },
        sender: { id: actorNodeId },
      },
      conversation: {
        id: route.conversationId,
        kind: 'direct',
        label: `${repository}#${input.item.number}`,
        routePeer: { id: route.conversationId, kind: 'direct' },
      },
      extra: {
        UntrustedStructuredContext: [
          githubNotificationAssignmentContext({ item: input.item, worktree: input.worktree }),
        ],
      },
      from: `github:${actorNodeId}`,
      message: {
        body,
        bodyForAgent: body,
        commandBody: '',
        inboundEventKind: 'room_event',
        rawBody: body,
      },
      messageId: `assignment:${input.item.intake?.assignmentEventId ?? input.item.itemNodeId}`,
      reply: { sourceReplyDeliveryMode: 'none', to: route.conversationId },
      route: {
        accountId: route.accountId,
        agentId: route.agentId,
        createIfMissing: true,
        routeSessionKey: route.sessionKey,
      },
      sender: {
        displayLabel: actorLogin,
        id: actorNodeId,
        isBot: false,
        isSelf: false,
        name: actorLogin,
        username: actorLogin,
      },
      surface: githubNotificationChannelId,
      timestamp: input.item.lastObservedAt,
    });
    let sessionRecordTask: Promise<unknown> | undefined;
    const result = await runPreparedInboundReply<void>({
      accountId: route.accountId,
      admission: { kind: 'observeOnly', reason: 'assignment-session-preparation' },
      afterRecord: async () => {
        if (!sessionRecordTask) {
          throw new Error('OpenClaw did not expose the assignment session record task.');
        }
        if (!(await sessionRecordTask)) {
          throw new Error('OpenClaw did not prepare the assignment session.');
        }
      },
      channel: githubNotificationChannelId,
      ctxPayload,
      messageId: `assignment:${input.item.intake?.assignmentEventId ?? input.item.itemNodeId}`,
      observeOnlyDispatchResult: undefined,
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
      routeSessionKey: route.sessionKey,
      runDispatch: async () => {
        throw new Error(
          'Observe-only assignment session preparation must not dispatch a model turn.',
        );
      },
      storePath: resolveStorePath(config.session?.store, { agentId: route.agentId }),
    });
    if (
      !result.dispatched ||
      result.admission.kind !== 'observeOnly' ||
      result.routeSessionKey !== route.sessionKey
    ) {
      throw new Error('OpenClaw did not record the expected assignment session.');
    }
    this.#dependencies.logger.info(
      `github-notifications: assignment session prepared agent=${route.agentId} item=${repository}#${input.item.number}`,
    );
  }
}
