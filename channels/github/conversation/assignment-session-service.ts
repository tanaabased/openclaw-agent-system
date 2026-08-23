import {
  buildChannelInboundEventContext,
  runPreparedInboundReply,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import type { Logger } from '../../../core/logger.ts';
import { githubNotificationAssignmentCard } from '../events/assignment.ts';
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
import { githubNotificationChannelId, resolveNotificationRoute } from '../routing/routing.ts';
import type GitHubNotificationAssignmentAcknowledgmentService from './assignment-acknowledgment-service.ts';

export interface GitHubNotificationAssignmentSessionServiceDependencies {
  acknowledgments: Pick<GitHubNotificationAssignmentAcknowledgmentService, 'publish'>;
  logger: Logger;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationAssignmentSessionInput {
  agentId: string;
  item: GitHubNotificationItemState;
  lifecycle: GitHubNotificationLifecycle;
  mode: Pick<GitHubNotificationMode, 'policy'>;
  signal?: AbortSignal;
  workspaceDir: string;
  worktree?: GitHubNotificationLifecycleWorktree;
}

/** Prepare one lifecycle assignment's deterministic OpenClaw session without a model turn. */
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
    const body = githubNotificationAssignmentCard(projection, input.mode.policy.label);
    const ctxPayload = buildChannelInboundEventContext({
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
        UntrustedStructuredContext: [githubNotificationAssignmentContext({ lifecycleContext })],
      },
      from: `github:${projection.sender.id}`,
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
    await this.#dependencies.acknowledgments.publish({
      agentId: input.agentId,
      item: input.item,
      modeId: input.mode.policy.id,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      workspaceDir: input.workspaceDir,
    });
    this.#dependencies.logger.info(
      `github-notifications: assignment session and acknowledgment prepared agent=${route.agentId} item=${repository}#${input.item.number}`,
    );
  }
}
