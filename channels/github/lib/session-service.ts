import { isAbsolute, resolve } from 'node:path';

import { resolveStorePath, type OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';
import {
  buildChannelInboundEventContext,
  type AssembledInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';

import type { GitHubNotificationAssignmentEvent } from '../channel.ts';
import {
  githubNotificationSessionExtensionNamespace,
  type GitHubNotificationSessionMetadata,
} from './session-extension.ts';
import { githubNotificationChannelId, type ResolvedNotificationRoute } from '../utils/routing.ts';

const maximumBriefingLength = 16_384;

type GatewayRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface GitHubNotificationSessionServiceDependencies {
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  gatewayRequest: GatewayRequest;
  pluginId: string;
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

export interface GitHubNotificationSessionReference {
  agentId: string;
  sessionKey: string;
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

function assertSessionPatchResult(value: unknown, expectedSessionKey: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenClaw returned an invalid notification session patch result.');
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true || result.key !== expectedSessionKey) {
    throw new Error('OpenClaw did not patch the expected notification session.');
  }
}

function assertSessionPluginPatchResult(value: unknown, expectedSessionKey: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenClaw returned an invalid notification session metadata result.');
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true || result.key !== expectedSessionKey) {
    throw new Error('OpenClaw did not patch metadata for the expected notification session.');
  }
}

function assertSessionAbortResult(value: unknown): 'aborted' | 'no-active-run' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenClaw returned an invalid notification session abort result.');
  }
  const result = value as Record<string, unknown>;
  if (
    result.ok !== true ||
    (result.status !== 'aborted' && result.status !== 'no-active-run') ||
    (result.abortedRunId !== null && typeof result.abortedRunId !== 'string')
  ) {
    throw new Error('OpenClaw did not return a valid notification session abort status.');
  }
  if (result.status === 'aborted' && !result.abortedRunId) {
    throw new Error('OpenClaw omitted the aborted notification run id.');
  }
  if (result.status === 'no-active-run' && result.abortedRunId !== null) {
    throw new Error('OpenClaw returned a run id when no notification run was active.');
  }
  return result.status;
}

/** Build a local-only, no-tools assignment turn for one installed notification session. */
export default class GitHubNotificationSessionService {
  readonly #dependencies: GitHubNotificationSessionServiceDependencies;

  public constructor(dependencies: GitHubNotificationSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public prepareTurn(input: GitHubNotificationSessionTurnInput): AssembledInboundReply {
    const briefing = requiredText(
      input.briefing,
      'GitHub notification briefings',
      maximumBriefingLength,
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
    const metadata: GitHubNotificationSessionMetadata = {
      assignmentEventId: eventId,
      itemNumber: input.event.itemNumber,
      itemType: input.event.itemType,
      repositoryId,
      schemaVersion: 1,
      status: 'briefing',
      worktreeBranch,
      worktreePath,
    };

    return {
      accountId: input.route.accountId,
      afterRecord: async () => {
        const result = await this.#dependencies.gatewayRequest('sessions.patch', {
          agentId: input.route.agentId,
          archived: false,
          key: input.route.sessionKey,
          label,
          sendPolicy: 'deny',
        });
        assertSessionPatchResult(result, input.route.sessionKey);
        const metadataResult = await this.#dependencies.gatewayRequest('sessions.pluginPatch', {
          key: input.route.sessionKey,
          namespace: githubNotificationSessionExtensionNamespace,
          pluginId: this.#dependencies.pluginId,
          value: metadata,
        });
        assertSessionPluginPatchResult(metadataResult, input.route.sessionKey);
      },
      agentId: input.route.agentId,
      cfg: input.config,
      channel: githubNotificationChannelId,
      ctxPayload,
      delivery: {
        deliver: async () => undefined,
      },
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
      storePath: resolveStorePath(undefined, { agentId: input.route.agentId }),
      toolsAllow: [],
    };
  }

  /** Abort any active automated turn without deleting the session or transcript. */
  public async abortBriefing(
    reference: GitHubNotificationSessionReference,
  ): Promise<'aborted' | 'no-active-run'> {
    const result = await this.#dependencies.gatewayRequest('sessions.abort', {
      agentId: requiredText(reference.agentId, 'GitHub notification agent ids'),
      key: requiredText(reference.sessionKey, 'GitHub notification session keys'),
    });
    return assertSessionAbortResult(result);
  }

  /** Abort active work and archive the session while preserving its transcript. */
  public async retireSession(
    reference: GitHubNotificationSessionReference,
  ): Promise<'aborted' | 'no-active-run'> {
    const agentId = requiredText(reference.agentId, 'GitHub notification agent ids');
    const sessionKey = requiredText(reference.sessionKey, 'GitHub notification session keys');
    const abortStatus = await this.abortBriefing({ agentId, sessionKey });
    const result = await this.#dependencies.gatewayRequest('sessions.patch', {
      agentId,
      archived: true,
      key: sessionKey,
    });
    assertSessionPatchResult(result, sessionKey);
    return abortStatus;
  }
}
