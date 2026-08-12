import { isAbsolute, resolve } from 'node:path';

import {
  buildChannelInboundEventContext,
  type AssembledInboundReply,
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
import {
  buildGitHubNotificationBriefing,
  maximumGitHubNotificationBriefingLength,
  type GitHubNotificationBriefingData,
} from '../utils/briefing.ts';
import type { GitHubNotificationObservedSession } from '../utils/delivery-plan.ts';
import {
  githubNotificationChannelId,
  resolveNotificationRoute,
  type NotificationRoutingDesiredState,
  type ResolvedNotificationRoute,
} from '../utils/routing.ts';

export interface GitHubNotificationSessionServiceDependencies {
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  loadBriefing(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationBriefingData>;
  readConfig(): OpenClawConfig | Promise<OpenClawConfig>;
  recordInboundSession: AssembledInboundReply['recordInboundSession'];
}

export interface GitHubNotificationSessionTurnInput {
  briefing: string;
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

/** Dispatch one assignment through OpenClaw's channel-owned session lifecycle. */
export default class GitHubNotificationSessionService implements GitHubNotificationAssignmentSessions {
  readonly #dependencies: GitHubNotificationSessionServiceDependencies;

  public constructor(dependencies: GitHubNotificationSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async dispatchBriefing(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationObservedSession> {
    const assignment = await this.#resolveAssignment(input);
    const data = await this.#dependencies.loadBriefing(input);
    const briefing = buildGitHubNotificationBriefing({
      ...data,
      item: input.item,
      worktree: input.worktree,
    });
    const event = { ...assignment.event, timestamp: Date.parse(data.assignmentAt) };
    const result = await runGitHubNotificationAssignment(event, {
      config: assignment.config,
      desired: assignment.desired,
      prepareTurn: (event, route) =>
        this.prepareTurn({
          briefing,
          config: assignment.config,
          event,
          label: assignment.label,
          route,
          worktreeBranch: input.worktree.branch,
          worktreePath: input.worktree.path,
        }),
    });
    if (!result.dispatched || result.routeSessionKey !== assignment.route.sessionKey) {
      throw new Error('OpenClaw did not dispatch the expected notification session.');
    }
    return { key: result.routeSessionKey, status: 'active' };
  }

  public prepareTurn(input: GitHubNotificationSessionTurnInput): AssembledInboundReply {
    const briefing = requiredText(
      input.briefing,
      'GitHub notification briefings',
      maximumGitHubNotificationBriefingLength,
    );
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
        body: briefing,
        bodyForAgent: briefing,
        commandBody: '',
        inboundEventKind: 'user_request',
        rawBody: briefing,
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
      agentId: input.route.agentId,
      cfg: input.config,
      channel: githubNotificationChannelId,
      ctxPayload,
      delivery: { deliver: async () => undefined },
      dispatchReplyWithBufferedBlockDispatcher:
        this.#dependencies.dispatchReplyWithBufferedBlockDispatcher,
      messageId: eventId,
      record: { createIfMissing: true },
      recordInboundSession: this.#dependencies.recordInboundSession,
      replyOptions: {
        disableTools: true,
        sourceReplyDeliveryMode: 'message_tool_only',
        suppressDefaultToolProgressMessages: true,
        suppressTyping: true,
        toolsAllow: [],
      },
      routeSessionKey: input.route.sessionKey,
      storePath: resolveStorePath(input.config.session?.store, {
        agentId: input.route.agentId,
      }),
      toolsAllow: [],
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
