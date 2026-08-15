import { isAbsolute, resolve } from 'node:path';

import {
  buildChannelInboundEventContext,
  type PreparedInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';
import { resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime';

import type {
  GitHubNotificationAssignmentSessions,
  GitHubNotificationAssignmentSessionInput,
} from './assignment-orchestrator.ts';
import {
  githubNotificationConversationId,
  runGitHubNotificationAssignment,
  type GitHubNotificationAssignmentEvent,
} from '../channel.ts';
import resolveGitHubNotificationMessage from './message-registry.ts';
import githubNotificationAssignmentCard from '../messages/presentation/assignment-card.ts';
import type { GitHubNotificationExecutionMode } from '../messages/types.ts';
import type {
  GitHubNotificationObservedSession,
  GitHubNotificationRecordedSession,
} from '../utils/delivery-plan.ts';
import type { GitHubNotificationPullRequestState } from '../utils/monitor-state.ts';
import {
  githubNotificationChannelId,
  resolveNotificationRoute,
  type NotificationRoutingDesiredState,
  type ResolvedNotificationRoute,
} from '../utils/routing.ts';

export interface GitHubNotificationAssignmentSessionServiceDependencies {
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

export interface GitHubNotificationSessionTurnInput {
  config: OpenClawConfig;
  event: GitHubNotificationAssignmentEvent;
  label: string;
  mode: GitHubNotificationExecutionMode;
  pullRequest?: GitHubNotificationPullRequestState;
  route: ResolvedNotificationRoute;
  worktree?: { branch: string; path: string };
}

export interface ResolvedGitHubNotificationAssignmentSession {
  config: OpenClawConfig;
  desired: NotificationRoutingDesiredState;
  event: GitHubNotificationAssignmentEvent;
  label: string;
  mode: GitHubNotificationExecutionMode;
  route: ResolvedNotificationRoute;
  workContext: Record<string, string>;
}

export function githubNotificationRequiredText(
  value: string,
  label: string,
  maximumLength?: number,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (maximumLength !== undefined && normalized.length > maximumLength) {
    throw new Error(`${label} must not exceed ${maximumLength} characters.`);
  }
  return normalized;
}

function absolutePath(value: string, label: string): string {
  const normalized = resolve(githubNotificationRequiredText(value, label, 4_096));
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return normalized;
}

function assignmentContext(input: {
  itemType: GitHubNotificationAssignmentEvent['itemType'];
  pullRequest?: GitHubNotificationPullRequestState;
  worktree?: { branch: string; path: string };
}): Record<string, string> {
  if (input.itemType === 'issue') {
    if (!input.worktree) throw new Error('GitHub issue assignments require a managed worktree.');
    return {
      githubWorktreeBranch: githubNotificationRequiredText(
        input.worktree.branch,
        'GitHub notification worktree branches',
        255,
      ),
      githubWorktreePath: absolutePath(input.worktree.path, 'GitHub notification worktree paths'),
    };
  }
  if (!input.pullRequest) {
    throw new Error('GitHub pull-request assignments require observed head metadata.');
  }
  const headSha = githubNotificationRequiredText(
    input.pullRequest.headSha,
    'GitHub pull-request head SHAs',
    64,
  );
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(headSha)) {
    throw new Error('GitHub pull-request head SHAs are invalid.');
  }
  return {
    githubPullRequestHeadRef: githubNotificationRequiredText(
      input.pullRequest.headRef,
      'GitHub pull-request head refs',
      255,
    ),
    githubPullRequestHeadSha: headSha,
  };
}

/** Own assignment-card recording in the assignment's private OpenClaw session. */
export default class GitHubNotificationAssignmentSessionService implements GitHubNotificationAssignmentSessions {
  readonly #dependencies: GitHubNotificationAssignmentSessionServiceDependencies;

  public constructor(dependencies: GitHubNotificationAssignmentSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async recordSession(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationObservedSession> {
    const assignment = await this.resolve(input);
    const result = await runGitHubNotificationAssignment(assignment.event, {
      config: assignment.config,
      desired: assignment.desired,
      prepareTurn: (event, route) =>
        this.prepareTurn({
          config: assignment.config,
          event,
          label: assignment.label,
          mode: assignment.mode,
          ...(input.item.pullRequest === undefined ? {} : { pullRequest: input.item.pullRequest }),
          route,
          ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
        }),
    });
    if (
      !result.dispatched ||
      result.admission.kind !== 'observeOnly' ||
      result.routeSessionKey !== assignment.route.sessionKey
    ) {
      throw new Error('OpenClaw did not record the expected notification session.');
    }
    const recorded: GitHubNotificationRecordedSession = {
      key: result.routeSessionKey,
      mode: assignment.mode,
      status: 'received',
    };
    await input.onSessionRecorded?.(recorded);
    return {
      key: result.routeSessionKey,
      mode: assignment.mode,
      status: 'active',
    };
  }

  public prepareTurn(input: GitHubNotificationSessionTurnInput): PreparedInboundReply<void> {
    let sessionRecordTask: Promise<unknown> | undefined;
    const eventId = githubNotificationRequiredText(
      input.event.id,
      'GitHub notification event ids',
      256,
    );
    const label = githubNotificationRequiredText(
      input.label,
      'GitHub notification session labels',
      120,
    );
    const repositoryId = githubNotificationRequiredText(
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
    const workContext = assignmentContext({
      itemType: input.event.itemType,
      ...(input.pullRequest === undefined ? {} : { pullRequest: input.pullRequest }),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    });
    const conversationId = input.route.conversationId;
    const notification = githubNotificationRequiredText(
      input.event.title,
      'GitHub notification assignment notices',
      2_000,
    );
    const request = {
      assignmentKind: input.event.itemType,
      event: 'assignment-received' as const,
      mode: input.mode,
    };
    resolveGitHubNotificationMessage(request);
    const ctxPayload = buildChannelInboundEventContext({
      accountId: input.route.accountId,
      channel: githubNotificationChannelId,
      channelContext: {
        chat: { agentSystemGitHubNotification: request, id: conversationId },
        sender: { id: 'github-notifications' },
      },
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
        ...workContext,
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

  public async resolve(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<ResolvedGitHubNotificationAssignmentSession> {
    const config = await this.#dependencies.readConfig();
    const desired = {
      agentId: input.agentId,
      enabled: true,
      workspaceDir: input.workspaceDir,
    };
    const mode = input.delivery.mode ?? 'plan';
    const event = {
      id: input.delivery.assignmentEventId,
      itemNumber: input.item.number,
      itemType: input.item.itemType,
      repositoryId: input.item.repositoryNodeId,
      title: githubNotificationAssignmentCard({ item: input.item, mode }),
    };
    const route = resolveNotificationRoute(
      config,
      desired,
      githubNotificationConversationId(event),
    );
    const assignmentLabel =
      input.item.itemType === 'issue'
        ? input.worktree?.branch
        : input.item.pullRequest === undefined
          ? undefined
          : `head@${input.item.pullRequest.headSha.slice(0, 12)}`;
    if (!assignmentLabel) {
      throw new Error(
        `GitHub ${input.item.itemType} assignments are missing their required local context.`,
      );
    }
    const label =
      `${input.item.repositoryOwner}/${input.item.repositoryName}#${input.item.number} · ${assignmentLabel}`
        .slice(0, 120)
        .trim();
    const workContext = assignmentContext({
      itemType: event.itemType,
      ...(input.item.pullRequest === undefined ? {} : { pullRequest: input.item.pullRequest }),
      ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
    });
    return { config, desired, event, label, mode, route, workContext };
  }
}
