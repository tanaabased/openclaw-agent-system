import { isAbsolute, resolve } from 'node:path';

import { resolveStorePath, type OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';
import {
  buildChannelInboundEventContext,
  type AssembledInboundReply,
} from 'openclaw/plugin-sdk/channel-inbound';

import type {
  GitHubNotificationAssignmentSessions,
  GitHubNotificationAssignmentSessionInput,
} from '../../../lib/github-notification-assignment-orchestrator.ts';
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
  githubNotificationSessionEntrySlot,
  githubNotificationSessionExtensionNamespace,
  parseGitHubNotificationSessionMetadata,
  type GitHubNotificationSessionMetadata,
} from './session-extension.ts';
import {
  githubNotificationChannelId,
  resolveNotificationRoute,
  type NotificationRoutingDesiredState,
  type ResolvedNotificationRoute,
} from '../utils/routing.ts';

type GatewayRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface GitHubNotificationSessionServiceDependencies {
  dispatchReplyWithBufferedBlockDispatcher: AssembledInboundReply['dispatchReplyWithBufferedBlockDispatcher'];
  gatewayRequest: GatewayRequest;
  loadBriefing(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationBriefingData>;
  pluginId: string;
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

export interface GitHubNotificationSessionReference {
  agentId: string;
  sessionKey: string;
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sessionCreateResult(
  value: unknown,
  expectedSessionKey: string,
): { id?: string; key: string } {
  const result = record(value);
  if (
    result?.ok !== true ||
    result.key !== expectedSessionKey ||
    (result.sessionId !== undefined && typeof result.sessionId !== 'string')
  ) {
    throw new Error('OpenClaw did not create or adopt the expected notification session.');
  }
  return {
    ...(result.sessionId === undefined ? {} : { id: result.sessionId }),
    key: expectedSessionKey,
  };
}

function sessionDescription(value: unknown): Record<string, unknown> | undefined {
  const result = record(value);
  if (!result || !Object.hasOwn(result, 'session')) {
    throw new Error('OpenClaw returned an invalid notification session description.');
  }
  if (result.session === null) return undefined;
  const session = record(result.session);
  if (!session) throw new Error('OpenClaw returned an invalid notification session row.');
  return session;
}

function sessionMetadataValue(session: Record<string, unknown>, pluginId: string): unknown {
  if (session[githubNotificationSessionEntrySlot] !== undefined) {
    return session[githubNotificationSessionEntrySlot];
  }
  if (!Array.isArray(session.pluginExtensions)) return undefined;
  return session.pluginExtensions
    .map((value) => record(value))
    .find(
      (value) =>
        value?.pluginId === pluginId &&
        value.namespace === githubNotificationSessionExtensionNamespace,
    )?.value;
}

function messageId(value: unknown): string | undefined {
  const message = record(value);
  if (!message) return undefined;
  for (const candidate of [message.messageId, message.id, record(message.__openclaw)?.id]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function messageRole(value: unknown): string | undefined {
  const role = record(value)?.role;
  return typeof role === 'string' ? role.toLowerCase() : undefined;
}

function historyObservation(
  value: unknown,
  eventId: string,
): 'absent' | 'briefing-running' | 'active' {
  const result = record(value);
  if (!result || !Array.isArray(result.messages)) {
    throw new Error('OpenClaw returned invalid notification session history.');
  }
  const eventIndex = result.messages.findIndex((message) => messageId(message) === eventId);
  if (eventIndex === -1) return 'absent';
  return result.messages
    .slice(eventIndex + 1)
    .some((message) => messageRole(message) === 'assistant')
    ? 'active'
    : 'briefing-running';
}

function metadata(
  input: GitHubNotificationAssignmentSessionInput,
  status: GitHubNotificationSessionMetadata['status'],
): GitHubNotificationSessionMetadata {
  return {
    assignmentEventId: input.delivery.assignmentEventId,
    itemNumber: input.item.number,
    itemType: input.item.itemType,
    repositoryId: input.item.repositoryNodeId,
    schemaVersion: 1,
    status,
    worktreeBranch: input.worktree.branch,
    worktreePath: input.worktree.path,
  };
}

function metadataMatches(
  value: GitHubNotificationSessionMetadata,
  expected: GitHubNotificationSessionMetadata,
): boolean {
  return (
    value.assignmentEventId === expected.assignmentEventId &&
    value.itemNumber === expected.itemNumber &&
    value.itemType === expected.itemType &&
    value.repositoryId === expected.repositoryId &&
    value.worktreeBranch === expected.worktreeBranch &&
    resolve(value.worktreePath) === resolve(expected.worktreePath)
  );
}

/** Build a local-only, no-tools assignment turn for one installed notification session. */
export default class GitHubNotificationSessionService implements GitHubNotificationAssignmentSessions {
  readonly #dependencies: GitHubNotificationSessionServiceDependencies;

  public constructor(dependencies: GitHubNotificationSessionServiceDependencies) {
    this.#dependencies = dependencies;
  }

  public async prepare(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationObservedSession> {
    const assignment = await this.#resolveAssignment(input);
    const created = sessionCreateResult(
      await this.#dependencies.gatewayRequest('sessions.create', {
        agentId: input.agentId,
        key: assignment.route.sessionKey,
        label: assignment.label,
      }),
      assignment.route.sessionKey,
    );
    assertSessionPatchResult(
      await this.#dependencies.gatewayRequest('sessions.patch', {
        agentId: input.agentId,
        archived: false,
        key: assignment.route.sessionKey,
        label: assignment.label,
        sendPolicy: 'deny',
      }),
      assignment.route.sessionKey,
    );
    return { ...created, status: 'ready' };
  }

  public async inspect(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationObservedSession | undefined> {
    const assignment = await this.#resolveAssignment(input);
    const session = sessionDescription(
      await this.#dependencies.gatewayRequest('sessions.describe', {
        key: assignment.route.sessionKey,
      }),
    );
    if (!session) return undefined;
    if (session.key !== assignment.route.sessionKey) {
      throw new Error('OpenClaw described another notification session.');
    }
    if (session.sessionId !== undefined && typeof session.sessionId !== 'string') {
      throw new Error('OpenClaw returned an invalid notification session id.');
    }
    const reference = {
      ...(session.sessionId === undefined ? {} : { id: session.sessionId }),
      key: assignment.route.sessionKey,
    };
    if (session.archived === true) return { ...reference, status: 'retired' };
    const rawMetadata = sessionMetadataValue(session, this.#dependencies.pluginId);
    const observedMetadata = parseGitHubNotificationSessionMetadata(rawMetadata);
    if (rawMetadata !== undefined && !observedMetadata) {
      throw new Error('OpenClaw returned invalid notification session metadata.');
    }
    const expectedMetadata = metadata(input, 'briefing');
    if (observedMetadata && !metadataMatches(observedMetadata, expectedMetadata)) {
      throw new Error('The notification session belongs to another assignment.');
    }
    if (observedMetadata?.status === 'retired') return { ...reference, status: 'retired' };
    if (observedMetadata?.status === 'active') return { ...reference, status: 'active' };
    const history = historyObservation(
      await this.#dependencies.gatewayRequest('chat.history', {
        agentId: input.agentId,
        limit: 50,
        maxChars: maximumGitHubNotificationBriefingLength,
        sessionKey: assignment.route.sessionKey,
      }),
      input.delivery.assignmentEventId,
    );
    if (history === 'active') {
      await this.#patchMetadata(input, assignment.route.sessionKey, 'active');
      return { ...reference, status: 'active' };
    }
    if (history === 'briefing-running' || observedMetadata?.status === 'briefing') {
      return { ...reference, status: 'briefing-running' };
    }
    return { ...reference, status: 'ready' };
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
    await runGitHubNotificationAssignment(event, {
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
    await this.#patchMetadata(input, assignment.route.sessionKey, 'active');
    return {
      ...(input.delivery.sessionId === undefined ? {} : { id: input.delivery.sessionId }),
      key: assignment.route.sessionKey,
      status: 'active',
    };
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

  async #patchMetadata(
    input: GitHubNotificationAssignmentSessionInput,
    sessionKey: string,
    status: GitHubNotificationSessionMetadata['status'],
  ): Promise<void> {
    assertSessionPluginPatchResult(
      await this.#dependencies.gatewayRequest('sessions.pluginPatch', {
        key: sessionKey,
        namespace: githubNotificationSessionExtensionNamespace,
        pluginId: this.#dependencies.pluginId,
        value: metadata(input, status),
      }),
      sessionKey,
    );
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
