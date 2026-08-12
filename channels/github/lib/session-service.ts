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
import type { GitHubNotificationObservedSession } from '../utils/delivery-plan.ts';
import {
  githubNotificationChannelId,
  resolveNotificationRoute,
  type NotificationRoutingDesiredState,
  type ResolvedNotificationRoute,
} from '../utils/routing.ts';

export interface GitHubNotificationSessionServiceDependencies {
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: PreparedInboundReply<void>['recordInboundSession'];
}

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

  public prepareTurn(input: GitHubNotificationSessionTurnInput): PreparedInboundReply<void> {
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
    const notification = `GitHub ${input.event.itemType} #${input.event.itemNumber} was assigned to this agent.`;
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
      provider: 'github',
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
      record: { createIfMissing: true },
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
      title: `GitHub ${input.item.itemType} #${input.item.number} assignment`,
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
